import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashToken } from "./id";
import { MAX_CIPHERTEXT, type ShareRecord, type ShareStore } from "./types";

/**
 * Filesystem backend: no accounts, no third-party service, no network.
 *
 * This is what Docker self-hosting runs, and what the test suite exercises.
 * It is also the fallback when the hosted credentials are absent, so `npm run
 * dev` works out of the box.
 */

interface StoredMeta extends ShareRecord {
  readonly manageTokenHash: string;
}

/**
 * Per-id mutex.
 *
 * A read-then-write claim counter is a TOCTOU race: two concurrent requests
 * both observe `remaining > 0` and both get served. Serialising per id closes
 * it within a process, which is all a single-container deployment needs. The
 * hosted backend uses Redis `DECR` instead, because serverless has no shared
 * memory to serialise in.
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    id,
    next.catch(() => undefined).finally(() => {
      if (locks.get(id) === next) locks.delete(id);
    }),
  );
  return next;
}

export class FileShareStore implements ShareStore {
  constructor(private readonly root: string) {}

  private blobPath(id: string): string {
    return path.join(this.root, `${id}.bin`);
  }

  private metaPath(id: string): string {
    return path.join(this.root, `${id}.json`);
  }

  private async readMeta(id: string): Promise<StoredMeta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(id), "utf8")) as StoredMeta;
    } catch {
      return null;
    }
  }

  async put(args: {
    id: string;
    ciphertext?: Uint8Array;
    size: number;
    ttlMs: number;
    maxClaims: number;
    manageTokenHash: string;
  }): Promise<ShareRecord> {
    const { id, ciphertext, ttlMs, maxClaims, manageTokenHash } = args;
    if (!ciphertext) throw new Error("The filesystem store needs the ciphertext itself.");
    if (ciphertext.length > MAX_CIPHERTEXT) throw new Error("Ciphertext exceeds the size cap.");

    await mkdir(this.root, { recursive: true });
    const now = Date.now();
    const meta: StoredMeta = {
      id,
      size: ciphertext.length,
      createdAt: now,
      expiresAt: now + ttlMs,
      remaining: maxClaims,
      manageTokenHash,
    };
    await writeFile(this.blobPath(id), ciphertext);
    await writeFile(this.metaPath(id), JSON.stringify(meta));
    const { manageTokenHash: _omit, ...record } = meta;
    return record;
  }

  async stat(id: string): Promise<ShareRecord | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    if (Date.now() > meta.expiresAt || meta.remaining <= 0) {
      await this.destroy(id);
      return null;
    }
    const { manageTokenHash: _omit, ...record } = meta;
    return record;
  }

  async claim(id: string): Promise<{ record: ShareRecord; ciphertext: Uint8Array } | null> {
    return withLock(id, async () => {
      const meta = await this.readMeta(id);
      if (!meta) return null;

      if (Date.now() > meta.expiresAt || meta.remaining <= 0) {
        await this.destroy(id);
        return null;
      }

      const ciphertext = new Uint8Array(await readFile(this.blobPath(id)));
      const updated: StoredMeta = { ...meta, remaining: meta.remaining - 1 };

      if (updated.remaining <= 0) {
        await this.destroy(id);
      } else {
        await writeFile(this.metaPath(id), JSON.stringify(updated));
      }

      const { manageTokenHash: _omit, ...record } = updated;
      return { record, ciphertext };
    });
  }

  async revoke(id: string, manageToken: string): Promise<boolean> {
    const meta = await this.readMeta(id);
    if (!meta) return false;
    if ((await hashToken(manageToken)) !== meta.manageTokenHash) return false;
    await this.destroy(id);
    return true;
  }

  async destroy(id: string): Promise<void> {
    await Promise.allSettled([
      rm(this.blobPath(id), { force: true }),
      rm(this.metaPath(id), { force: true }),
    ]);
  }
}
