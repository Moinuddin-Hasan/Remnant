import type { ByteRange } from "./types";

const BLOCK = 1 << 18; // 256 KB
const MAX_CACHED_BLOCKS = 24; // ~6 MB ceiling regardless of file size

/**
 * A ranged, lazy view over a Blob.
 *
 * `Blob.slice()` returns a new disk-backed reference and reads nothing, so a
 * 200 MB video costs a few hundred kilobytes of cache here rather than 200 MB
 * of renderer heap. Every parser in this codebase reads through this and never
 * calls `file.arrayBuffer()`.
 */
export interface Reader {
  readonly size: number;
  bytes(range: ByteRange): Promise<Uint8Array>;
  u8(at: number): Promise<number>;
  u16be(at: number): Promise<number>;
  u16le(at: number): Promise<number>;
  u32be(at: number): Promise<number>;
  u32le(at: number): Promise<number>;
  /** Byte offset of `needle`, or -1. Searches [from, from+limit). */
  find(needle: Uint8Array, from?: number, limit?: number): Promise<number>;
  ascii(range: ByteRange): Promise<string>;
  source(): Blob;
}

class BlobReader implements Reader {
  readonly size: number;
  private readonly blob: Blob;
  private readonly cache = new Map<number, Uint8Array>();

  constructor(blob: Blob) {
    this.blob = blob;
    this.size = blob.size;
  }

  private async block(index: number): Promise<Uint8Array> {
    const hit = this.cache.get(index);
    if (hit) return hit;
    const start = index * BLOCK;
    const end = Math.min(start + BLOCK, this.size);
    const buf = new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
    if (this.cache.size >= MAX_CACHED_BLOCKS) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(index, buf);
    return buf;
  }

  async bytes(range: ByteRange): Promise<Uint8Array> {
    const start = Math.max(0, range.start);
    const end = Math.min(this.size, range.end);
    if (end <= start) return new Uint8Array(0);

    // Anything larger than a couple of blocks goes straight to the blob rather
    // than thrashing the cache with data we will not read again.
    if (end - start > BLOCK * 2) {
      return new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
    }

    const first = Math.floor(start / BLOCK);
    const last = Math.floor((end - 1) / BLOCK);
    if (first === last) {
      const b = await this.block(first);
      return b.subarray(start - first * BLOCK, end - first * BLOCK);
    }
    const out = new Uint8Array(end - start);
    let written = 0;
    for (let i = first; i <= last; i++) {
      const b = await this.block(i);
      const bStart = i * BLOCK;
      const from = Math.max(start, bStart) - bStart;
      const to = Math.min(end, bStart + b.length) - bStart;
      out.set(b.subarray(from, to), written);
      written += to - from;
    }
    return out;
  }

  async u8(at: number): Promise<number> {
    return (await this.bytes({ start: at, end: at + 1 }))[0] ?? 0;
  }

  async u16be(at: number): Promise<number> {
    const b = await this.bytes({ start: at, end: at + 2 });
    return ((b[0] ?? 0) << 8) | (b[1] ?? 0);
  }

  async u16le(at: number): Promise<number> {
    const b = await this.bytes({ start: at, end: at + 2 });
    return ((b[1] ?? 0) << 8) | (b[0] ?? 0);
  }

  async u32be(at: number): Promise<number> {
    const b = await this.bytes({ start: at, end: at + 4 });
    return (((b[0] ?? 0) << 24) >>> 0) + ((b[1] ?? 0) << 16) + ((b[2] ?? 0) << 8) + (b[3] ?? 0);
  }

  async u32le(at: number): Promise<number> {
    const b = await this.bytes({ start: at, end: at + 4 });
    return (((b[3] ?? 0) << 24) >>> 0) + ((b[2] ?? 0) << 16) + ((b[1] ?? 0) << 8) + (b[0] ?? 0);
  }

  async find(needle: Uint8Array, from = 0, limit = this.size): Promise<number> {
    if (needle.length === 0) return -1;
    const end = Math.min(this.size, from + limit);
    const step = BLOCK;
    const overlap = needle.length - 1;
    for (let pos = from; pos < end; pos += step - overlap) {
      const chunk = await this.bytes({ start: pos, end: Math.min(end, pos + step) });
      outer: for (let i = 0; i + needle.length <= chunk.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (chunk[i + j] !== needle[j]) continue outer;
        }
        return pos + i;
      }
      if (chunk.length < step) break;
    }
    return -1;
  }

  async ascii(range: ByteRange): Promise<string> {
    const b = await this.bytes(range);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
    return s;
  }

  source(): Blob {
    return this.blob;
  }
}

export const readerOf = (blob: Blob): Reader => new BlobReader(blob);

export const asciiBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
