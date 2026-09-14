import { del, head } from "@vercel/blob";
import { Redis } from "@upstash/redis";
import { hashToken } from "./id";
import {
  MAX_CIPHERTEXT,
  type ShareRecord,
  type ShareStore,
} from "./types";

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
 */

interface StoredMeta {
  readonly id: string;
  readonly blobUrl: string;
  readonly size: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly maxClaims: number;
  readonly manageTokenHash: string;
}

const metaKey = (id: string) => `share:${id}:meta`;
const countKey = (id: string) => `share:${id}:remaining`;

let redis: Redis | null = null;

export function hostedConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL &&
      process.env.UPSTASH_REDIS_REST_TOKEN &&
      process.env.BLOB_READ_WRITE_TOKEN,
  );
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

    const response = await fetch(meta.blobUrl, { cache: "no-store" });
    if (!response.ok) {
      await this.destroy(id);
      return null;
    }
    const ciphertext = new Uint8Array(await response.arrayBuffer());

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

  async destroy(id: string): Promise<void> {
    const meta = await this.meta(id);
    await Promise.allSettled([
      client().del(metaKey(id)),
      client().del(countKey(id)),
      meta ? del(meta.blobUrl) : Promise.resolve(),
    ]);
  }
}
