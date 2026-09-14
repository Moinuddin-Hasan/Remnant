import type { Reader } from "../../reader";

/**
 * ISOBMFF box grammar, shared by MP4/MOV (strippable) and HEIF/AVIF (read-only).
 *
 * A box is `size:4 BE | type:4 | body`. `size == 1` means a 64-bit size follows
 * the type; `size == 0` means "runs to the end of the enclosing space".
 */

export interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  /** First byte after the size/type (and 64-bit size) header. */
  readonly bodyStart: number;
  /** Type of the enclosing box; "" at the top level. */
  readonly parent: string;
  /** e.g. "moov/trak/udta". */
  readonly path: string;
  readonly children: readonly Box[];
}

export interface BoxTree {
  readonly boxes: readonly Box[];
  /** Places the walk had to stop. Rendered as unhandled, never swallowed. */
  readonly problems: readonly string[];
}

/** Boxes whose body is nothing but child boxes. `meta` is handled separately. */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "udta", "edts", "dinf", "mvex", "ilst"]);
const MAX_DEPTH = 10;

async function header(
  src: Reader,
  at: number,
  limit: number,
): Promise<{ type: string; size: number; hdr: number } | null> {
  const size32 = await src.u32be(at);
  const type = await src.ascii({ start: at + 4, end: at + 8 });
  let size = size32;
  let hdr = 8;
  if (size32 === 1) {
    if (at + 16 > limit) return null;
    size = (await src.u32be(at + 8)) * 2 ** 32 + (await src.u32be(at + 12));
    hdr = 16;
  } else if (size32 === 0) {
    size = limit - at;
  }
  if (size < hdr || at + size > limit) return null;
  return { type, size, hdr };
}

/**
 * ISO `meta` is a FullBox — four bytes of version/flags precede its children.
 * QuickTime's `meta` is a plain box whose first child (`hdlr`) starts at once.
 * Writers use both, sometimes in the same file, so detect rather than assume.
 */
async function metaChildrenStart(src: Reader, bodyStart: number, end: number): Promise<number> {
  if (bodyStart + 8 > end) return bodyStart;
  const t = await src.ascii({ start: bodyStart + 4, end: bodyStart + 8 });
  return ["hdlr", "keys", "ilst", "free"].includes(t) ? bodyStart : bodyStart + 4;
}

export async function walkRange(
  src: Reader,
  start: number,
  end: number,
  parent: string,
  path: string,
  depth: number,
  problems: string[],
): Promise<Box[]> {
  const out: Box[] = [];
  let at = start;
  // A trailing run shorter than a header (QuickTime's 4-byte udta terminator) is skipped.
  while (at + 8 <= end) {
    const h = await header(src, at, end);
    if (!h) {
      problems.push(
        `Malformed box at offset ${at.toLocaleString()} inside ${path || "the file"} — parsing stopped there.`,
      );
      break;
    }
    const boxEnd = at + h.size;
    const bodyStart = at + h.hdr;
    const here = path ? `${path}/${h.type}` : h.type;
    let children: Box[] = [];
    if (depth < MAX_DEPTH) {
      if (h.type === "meta") {
        const from = await metaChildrenStart(src, bodyStart, boxEnd);
        children = await walkRange(src, from, boxEnd, h.type, here, depth + 1, problems);
      } else if (CONTAINERS.has(h.type) || parent === "ilst") {
        // ilst items are not containers by name, but each holds a `data` box.
        children = await walkRange(src, bodyStart, boxEnd, h.type, here, depth + 1, problems);
      }
    }
    out.push({ type: h.type, start: at, end: boxEnd, bodyStart, parent, path: here, children });
    at = boxEnd;
  }
  return out;
}

export async function walkTree(src: Reader): Promise<BoxTree> {
  const problems: string[] = [];
  const boxes = await walkRange(src, 0, src.size, "", "", 0, problems);
  return { boxes, problems };
}

export function flatten(boxes: readonly Box[]): Box[] {
  const out: Box[] = [];
  const visit = (bs: readonly Box[]) => {
    for (const b of bs) {
      out.push(b);
      visit(b.children);
    }
  };
  visit(boxes);
  return out;
}

/**
 * A `free` box of exactly `n` bytes, payload zeroed. ISO/IEC 14496-12 §8.1.2
 * makes free-space boxes legal anywhere and their contents ignorable, so
 * swapping one in for a metadata box changes no parent size and no sample
 * offset.
 */
export function freeBox(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const dv = new DataView(out.buffer);
  if (n <= 0xffffffff) {
    dv.setUint32(0, n);
  } else {
    dv.setUint32(0, 1);
    dv.setUint32(8, Math.floor(n / 2 ** 32));
    dv.setUint32(12, n >>> 0);
  }
  out.set([0x66, 0x72, 0x65, 0x65], 4); // "free"
  return out;
}

/** Seconds between the QuickTime/ISO epoch (1904-01-01) and the Unix epoch. */
export const MAC_EPOCH_OFFSET = 2082844800;

export const macTime = (sec: number): Date | null =>
  sec > 0 ? new Date((sec - MAC_EPOCH_OFFSET) * 1000) : null;

/** The fixed-width creation/modification fields of mvhd, tkhd and mdhd. */
export async function headerTimes(
  src: Reader,
  b: Box,
): Promise<{ range: { start: number; end: number }; created: number; modified: number } | null> {
  if (b.bodyStart + 4 > b.end) return null;
  const v1 = (await src.u8(b.bodyStart)) === 1;
  const start = b.bodyStart + 4;
  const end = start + (v1 ? 16 : 8);
  if (end > b.end) return null;
  const u64 = async (at: number) => (await src.u32be(at)) * 2 ** 32 + (await src.u32be(at + 4));
  const created = v1 ? await u64(start) : await src.u32be(start);
  const modified = v1 ? await u64(start + 8) : await src.u32be(start + 4);
  return { range: { start, end }, created, modified };
}

/**
 * ISO 6709 point, as QuickTime and Apple write it: `±DD.DDDD±DDD.DDDD[±AAA]/`.
 * Also accepts the DDMM(.mm) and DDMMSS(.ss) forms the standard allows.
 */
export function parseIso6709(s: string): { lat: number; lon: number } | null {
  const m = /^([+-])(\d+(?:\.\d+)?)([+-])(\d+(?:\.\d+)?)/.exec(s.trim());
  if (!m) return null;
  const conv = (sign: string, digits: string, degLen: number): number => {
    const [int = "", frac] = digits.split(".");
    const tail = (from: number) => Number(`${int.slice(from)}${frac ? `.${frac}` : ""}`);
    let v: number;
    if (int.length <= degLen) v = Number(digits);
    else if (int.length === degLen + 2) v = Number(int.slice(0, degLen)) + tail(degLen) / 60;
    else v = Number(int.slice(0, degLen)) + Number(int.slice(degLen, degLen + 2)) / 60 + tail(degLen + 2) / 3600;
    return sign === "-" ? -v : v;
  };
  const lat = conv(m[1]!, m[2]!, 2);
  const lon = conv(m[3]!, m[4]!, 3);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { lat, lon };
}
