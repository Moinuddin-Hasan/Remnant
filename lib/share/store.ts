import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Server-side storage for share links.
 *
 * Deliberately filesystem-first: it needs no accounts, no third-party service,
 * and it is the same backend the Docker self-host image will use. A Vercel
 * Blob adapter implements this interface later without touching callers.
 *
 * The store holds ciphertext and an opaque id. It never sees a filename, a
 * MIME type or a key — those live inside the encrypted payload.
 */

export interface ShareRecord {
  readonly id: string;
  readonly size: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly remaining: number;
}

export interface ShareStore {
  put(id: string, ciphertext: Uint8Array, ttlMs: number, maxClaims: number): Promise<ShareRecord>;
  stat(id: string): Promise<ShareRecord | null>;
  /** Atomically consumes one claim and returns the bytes, or null. */
  claim(id: string): Promise<{ record: ShareRecord; ciphertext: Uint8Array } | null>;
  destroy(id: string): Promise<void>;
}

export const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_MAX_CLAIMS = 1;
export const MAX_CIPHERTEXT = 26 * 1024 * 1024; // 25 MB plaintext + GCM tag + padding headroom

/**
 * Per-id mutex.
 *
 * A read-then-write claim counter is a TOCTOU race: two concurrent requests
 * both observe `remaining > 0` and both get served. A link-preview crawler and
 * a human clicking within the same second is the expected case, not the
 * pathological one. Serialising per id closes it within a process; a
 * multi-process deployment needs a real atomic primitive (Redis DECR), which
 * is a note on the Blob adapter, not a gap here.
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

  private async readMeta(id: string): Promise<ShareRecord | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(id), "utf8")) as ShareRecord;
    } catch {
      return null;
    }
  }

  async put(
    id: string,
    ciphertext: Uint8Array,
    ttlMs = DEFAULT_TTL_MS,
    maxClaims = DEFAULT_MAX_CLAIMS,
  ): Promise<ShareRecord> {
    if (ciphertext.length > MAX_CIPHERTEXT) throw new Error("Ciphertext exceeds the size cap.");
    await mkdir(this.root, { recursive: true });
    const now = Date.now();
    const record: ShareRecord = {
      id,
      size: ciphertext.length,
      createdAt: now,
      expiresAt: now + ttlMs,
      remaining: maxClaims,
    };
    await writeFile(this.blobPath(id), ciphertext);
    await writeFile(this.metaPath(id), JSON.stringify(record));
    return record;
  }

  async stat(id: string): Promise<ShareRecord | null> {
    const record = await this.readMeta(id);
    if (!record) return null;
    if (Date.now() > record.expiresAt || record.remaining <= 0) {
      await this.destroy(id);
      return null;
    }
    return record;
  }

  async claim(id: string): Promise<{ record: ShareRecord; ciphertext: Uint8Array } | null> {
    return withLock(id, async () => {
      const record = await this.readMeta(id);
      if (!record) return null;

      if (Date.now() > record.expiresAt || record.remaining <= 0) {
        await this.destroy(id);
        return null;
      }

      const ciphertext = new Uint8Array(await readFile(this.blobPath(id)));
      const updated: ShareRecord = { ...record, remaining: record.remaining - 1 };

      if (updated.remaining <= 0) {
        await this.destroy(id);
      } else {
        await writeFile(this.metaPath(id), JSON.stringify(updated));
      }

      return { record: updated, ciphertext };
    });
  }

  async destroy(id: string): Promise<void> {
    await Promise.allSettled([
      rm(this.blobPath(id), { force: true }),
      rm(this.metaPath(id), { force: true }),
    ]);
  }
}

/** 128 bits of randomness, so the store is not enumerable. */
export function newShareId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let singleton: ShareStore | null = null;

export function shareStore(): ShareStore {
  if (!singleton) {
    singleton = new FileShareStore(process.env.REMNANT_SHARE_DIR ?? path.join(process.cwd(), ".share-data"));
  }
  return singleton;
}
