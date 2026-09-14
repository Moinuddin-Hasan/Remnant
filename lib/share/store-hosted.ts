import { del, get, head, list } from "@vercel/blob";
import { Redis } from "@upstash/redis";
import { blobPathFor, hashToken, SHARE_ID } from "./id";
import {
  MAX_CIPHERTEXT,
  QUOTA_BYTES,
  QUOTA_SOFT_LIMIT,
  type ShareRecord,
  type ShareStore,
} from "./types";

const PREFIX = "shares/";

/**
 * Hosted backend: ciphertext in Vercel Blob, claim state in Upstash Redis.
 *
 * The split matters. Blob has no atomic operations, so a claim counter kept
 * there is a read-then-write race — and a link-preview crawler arriving in the
 * same second as a human is the expected case, not a pathological one. Redis
 * `DECR` is atomic, so the counter is authoritative and Blob only ever stores
 * opaque bytes.
 *
 * Uploads never pass through a function: the browser PUTs ciphertext straight
 * to Blob with a short-lived token, which is both why a 100 MB video works at
 * all (Vercel caps request bodies at 4.5 MB) and why the server never touches
 * plaintext-adjacent data.
 *
 * The store is PRIVATE. Confidentiality does not depend on that — what lands
 * there is ciphertext encrypted with a key the server never receives — but the
 * claim does: a public blob URL is a bearer token, so anyone who obtained it
 * could keep fetching after the burn. Private blobs force every read back
 * through this code, which is where the atomic counter lives.
 */

interface StoredMeta {
  readonly id: string;
  readonly blobUrl: string;
  /** Private blobs are read by pathname through an authenticated call. */
  readonly pathname: string;
  readonly size: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly maxClaims: number;
  readonly manageTokenHash: string;
}

const metaKey = (id: string) => `share:${id}:meta`;
const countKey = (id: string) => `share:${id}:remaining`;

let redis: Redis | null = null;

/**
 * Blob accepts two kinds of credential and we must accept both.
 *
 * A static `BLOB_READ_WRITE_TOKEN` is the classic form. A store connected
 * through the newer integration instead authenticates with OIDC: the platform
 * injects `VERCEL_OIDC_TOKEN` at runtime and the project carries
 * `BLOB_STORE_ID`. Requiring only the static token made a perfectly working
 * OIDC store look unconfigured, which is what sent a live deployment down the
 * filesystem path and into `mkdir '/var/task/.share-data'`.
 */
export function blobConfigured(): boolean {
  if (process.env.BLOB_READ_WRITE_TOKEN) return true;
  return Boolean(process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN);
}

export function redisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export function hostedConfigured(): boolean {
  return redisConfigured() && blobConfigured();
}

/** Names exactly what is missing, so a misconfiguration reads as one. */
export function missingHostedConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.UPSTASH_REDIS_REST_URL) missing.push("UPSTASH_REDIS_REST_URL");
  if (!process.env.UPSTASH_REDIS_REST_TOKEN) missing.push("UPSTASH_REDIS_REST_TOKEN");
  if (!blobConfigured()) {
    missing.push("BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID + VERCEL_OIDC_TOKEN)");
  }
  return missing;
}

function client(): Redis {
  if (!redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Share storage is not configured: UPSTASH_REDIS_REST_URL and " +
          "UPSTASH_REDIS_REST_TOKEN must be set.",
      );
    }
    redis = new Redis({ url, token });
  }
  return redis;
}

const toRecord = (meta: StoredMeta, remaining: number): ShareRecord => ({
  id: meta.id,
  size: meta.size,
  createdAt: meta.createdAt,
  expiresAt: meta.expiresAt,
  remaining: Math.max(0, remaining),
});

export class HostedShareStore implements ShareStore {
  private async meta(id: string): Promise<StoredMeta | null> {
    const raw = await client().get<StoredMeta>(metaKey(id));
    return raw ?? null;
  }

  async put(args: {
    id: string;
    blobUrl?: string;
    size: number;
    ttlMs: number;
    maxClaims: number;
    manageTokenHash: string;
  }): Promise<ShareRecord> {
    const { id, blobUrl, size, ttlMs, maxClaims, manageTokenHash } = args;
    if (!blobUrl) throw new Error("Hosted shares require an uploaded blob URL.");
    if (size > MAX_CIPHERTEXT) throw new Error("Ciphertext exceeds the size cap.");

    // Reclaim before refusing: most of what fills a small quota is orphans, not
    // live shares, so a sweep usually makes room where a hard error would not.
    const before = await this.usage();
    if (before.bytes + size > QUOTA_SOFT_LIMIT) {
      const swept = await this.sweep();
      const after = await this.usage();
      if (after.bytes + size > QUOTA_SOFT_LIMIT) {
        throw new Error(
          `Share storage is full — ${(after.bytes / 1048576).toFixed(0)} MB of ` +
            `${(QUOTA_BYTES / 1048576).toFixed(0)} MB used, ${swept.deleted} orphan(s) reclaimed. ` +
            `Revoke a link from your dashboard and try again.`,
        );
      }
    }

    // The blob must already exist and match the declared size, or a client
    // could register a record pointing at somebody else's object.
    const info = await head(blobUrl).catch(() => null);
    if (!info) throw new Error("Upload not found.");
    if (info.size !== size) throw new Error("Declared size does not match the uploaded object.");
    if (!info.pathname.includes(id)) throw new Error("Upload does not belong to this share id.");

    const r = client();
    const now = Date.now();
    const meta: StoredMeta = {
      id,
      blobUrl,
      pathname: info.pathname,
      size,
      createdAt: now,
      expiresAt: now + ttlMs,
      maxClaims,
      manageTokenHash,
    };

    const ttlSeconds = Math.ceil(ttlMs / 1000);
    // NX: refuse to overwrite an existing share, so a guessed id cannot hijack one.
    const created = await r.set(metaKey(id), meta, { ex: ttlSeconds, nx: true });
    if (created === null) throw new Error("That share id is already taken.");
    await r.set(countKey(id), maxClaims, { ex: ttlSeconds });

    return toRecord(meta, maxClaims);
  }

  async stat(id: string): Promise<ShareRecord | null> {
    const meta = await this.meta(id);
    if (!meta) return null;
    if (Date.now() > meta.expiresAt) {
      await this.destroy(id);
      return null;
    }
    const remaining = (await client().get<number>(countKey(id))) ?? 0;
    if (remaining <= 0) return null;
    return toRecord(meta, remaining);
  }

  async claim(id: string): Promise<{ record: ShareRecord; ciphertext: Uint8Array } | null> {
    const meta = await this.meta(id);
    if (!meta) return null;
    if (Date.now() > meta.expiresAt) {
      await this.destroy(id);
      return null;
    }

    // The atomic step. Whoever drives the counter below zero has lost the race
    // and gets nothing back — no read-then-write window for a crawler to slip
    // through.
    const remaining = await client().decr(countKey(id));
    if (remaining < 0) {
      await client().set(countKey(id), 0);
      return null;
    }

    // Authenticated read. A private blob has no fetchable public URL, which is
    // the point — the bytes cannot be pulled without going through this claim.
    const found = await get(meta.pathname ?? blobPathFor(id), {
      access: "private",
      useCache: false,
    }).catch(() => null);
    if (!found || found.statusCode !== 200) {
      await this.destroy(id);
      return null;
    }
    const ciphertext = new Uint8Array(await new Response(found.stream).arrayBuffer());

    if (remaining === 0) await this.destroy(id);

    return { record: toRecord(meta, remaining), ciphertext };
  }

  async revoke(id: string, manageToken: string): Promise<boolean> {
    const meta = await this.meta(id);
    if (!meta) return false;
    if ((await hashToken(manageToken)) !== meta.manageTokenHash) return false;
    await this.destroy(id);
    return true;
  }

  /**
   * Deletes the object and CONFIRMS it is gone.
   *
   * On a 256 MB quota a silently-failed delete is not a cosmetic problem — it
   * is the thing that fills the store and takes sharing down mid-demo. `del`
   * resolving is not evidence; `head` 404ing afterwards is.
   */
  async destroy(id: string): Promise<{ deleted: boolean; verified: boolean }> {
    const meta = await this.meta(id);
    await Promise.allSettled([client().del(metaKey(id)), client().del(countKey(id))]);

    if (!meta) return { deleted: false, verified: true };

    try {
      await del(meta.blobUrl);
    } catch {
      return { deleted: false, verified: false };
    }

    const still = await head(meta.blobUrl).catch(() => null);
    return { deleted: true, verified: still === null };
  }

  /** What the store is actually holding, for the dashboard and the sweep. */
  async usage(): Promise<{ count: number; bytes: number; quota: number }> {
    let cursor: string | undefined;
    let count = 0;
    let bytes = 0;
    do {
      const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
      for (const b of page.blobs) {
        count += 1;
        bytes += b.size;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return { count, bytes, quota: QUOTA_BYTES };
  }

  /**
   * Deletes objects that nothing will ever reclaim.
   *
   * Two leaks make this necessary, and both fill a small quota quietly:
   *
   *   1. Redis meta carries a TTL, so an expired share's metadata disappears
   *      on its own — taking with it the only pointer to its blob. Without a
   *      sweep, every expired share leaves its ciphertext behind forever.
   *   2. A browser that uploads and then closes the tab before registering
   *      leaves an orphan that was never referenced at all.
   *
   * Blob is the source of truth here precisely because Redis forgets. Anything
   * older than the grace period with no live metadata goes.
   */
  async sweep(graceMs = 15 * 60 * 1000): Promise<{ scanned: number; deleted: number; freed: number }> {
    const now = Date.now();
    let cursor: string | undefined;
    let scanned = 0;
    let deleted = 0;
    let freed = 0;

    do {
      const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
      for (const blob of page.blobs) {
        scanned += 1;
        const age = now - new Date(blob.uploadedAt).getTime();
        if (age < graceMs) continue; // too new to judge — may be mid-registration

        const id = blob.pathname.replace(PREFIX, "").replace(/\.bin$/, "");
        const meta = SHARE_ID.test(id) ? await this.meta(id) : null;
        const live = meta !== null && now <= meta.expiresAt;
        if (live) continue;

        try {
          await del(blob.url);
          deleted += 1;
          freed += blob.size;
          if (SHARE_ID.test(id)) {
            await Promise.allSettled([client().del(metaKey(id)), client().del(countKey(id))]);
          }
        } catch {
          // Leave it for the next sweep rather than aborting the run.
        }
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    return { scanned, deleted, freed };
  }
}
