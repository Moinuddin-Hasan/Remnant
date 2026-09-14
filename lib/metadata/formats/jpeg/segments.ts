import type { Reader } from "../../reader";
import type { ByteRange } from "../../types";

export const SOI = 0xd8;
export const EOI = 0xd9;
export const SOS = 0xda;
export const COM = 0xfe;
export const DQT = 0xdb;
export const DHT = 0xc4;
export const DRI = 0xdd;
export const TEM = 0x01;

export const isApp = (m: number): boolean => m >= 0xe0 && m <= 0xef;
export const isRst = (m: number): boolean => m >= 0xd0 && m <= 0xd7;
/** SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC), which share the range. */
export const isSof = (m: number): boolean =>
  m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Standalone markers carry no length field. */
const isStandalone = (m: number): boolean => m === SOI || m === EOI || m === TEM || isRst(m);

export interface Segment {
  /** The marker byte itself, i.e. 0xE1 for APP1. */
  readonly marker: number;
  /** Offset of the leading 0xFF. */
  readonly start: number;
  /** Exclusive end. For SOS this includes the entropy-coded scan data. */
  readonly end: number;
  /** Offset of the payload, after the marker and the 2-byte length. */
  readonly dataStart: number;
  /** Identifier string for APPn segments, e.g. "Exif", "MPF", "http://ns.adobe.com/xap/1.0/". */
  readonly identifier?: string;
}

export interface JpegStructure {
  readonly segments: readonly Segment[];
  /** Range of the EOI marker, if one was found. */
  readonly eoi: ByteRange | null;
  /** Bytes after EOI. Non-empty means the file carries a trailer payload. */
  readonly trailer: ByteRange | null;
  readonly truncated: boolean;
}

const APP_ID_LIMIT = 64;

async function readIdentifier(src: Reader, seg: Omit<Segment, "identifier">): Promise<string | undefined> {
  if (!isApp(seg.marker)) return undefined;
  const end = Math.min(seg.dataStart + APP_ID_LIMIT, seg.end);
  const raw = await src.ascii({ start: seg.dataStart, end });
  const nul = raw.indexOf("\0");
  return nul >= 0 ? raw.slice(0, nul) : raw;
}

/**
 * Walk the JPEG marker chain.
 *
 * The whole strip strategy depends on this being a *whitelist* — we keep the
 * markers a decoder needs and drop everything else, rather than enumerating
 * the metadata segments we happen to know about. A blacklist is how
 * `piexif.remove()` ends up leaving XMP, ICC, IPTC and Adobe segments behind
 * while reporting success.
 */
export async function walkJpeg(src: Reader): Promise<JpegStructure> {
  const segments: Segment[] = [];
  let truncated = false;

  if ((await src.u8(0)) !== 0xff || (await src.u8(1)) !== SOI) {
    return { segments, eoi: null, trailer: null, truncated: true };
  }
  segments.push({ marker: SOI, start: 0, end: 2, dataStart: 2 });

  let pos = 2;
  let eoi: ByteRange | null = null;

  while (pos < src.size - 1) {
    // Skip fill bytes: a run of 0xFF before a marker is legal padding.
    let b = await src.u8(pos);
    while (b === 0xff && (await src.u8(pos + 1)) === 0xff) {
      pos += 1;
      b = await src.u8(pos);
    }
    if (b !== 0xff) {
      truncated = true;
      break;
    }

    const marker = await src.u8(pos + 1);

    if (marker === EOI) {
      eoi = { start: pos, end: pos + 2 };
      segments.push({ marker, start: pos, end: pos + 2, dataStart: pos + 2 });
      pos += 2;
      break;
    }

    if (isStandalone(marker)) {
      segments.push({ marker, start: pos, end: pos + 2, dataStart: pos + 2 });
      pos += 2;
      continue;
    }

    const length = await src.u16be(pos + 2);
    if (length < 2 || pos + 2 + length > src.size) {
      truncated = true;
      break;
    }
    const headerEnd = pos + 2 + length;

    if (marker === SOS) {
      // Entropy-coded data follows the SOS header and is not length-prefixed.
      // It ends at the first 0xFF that is neither stuffing (0xFF00) nor a
      // restart marker (0xFFD0..0xFFD7).
      const scanEnd = await findScanEnd(src, headerEnd);
      segments.push({
        marker,
        start: pos,
        end: scanEnd,
        dataStart: pos + 4,
      });
      pos = scanEnd;
      continue;
    }

    const partial = { marker, start: pos, end: headerEnd, dataStart: pos + 4 };
    segments.push({ ...partial, identifier: await readIdentifier(src, partial) });
    pos = headerEnd;
  }

  const trailerStart = eoi ? eoi.end : null;
  const trailer =
    trailerStart !== null && trailerStart < src.size
      ? { start: trailerStart, end: src.size }
      : null;

  return { segments, eoi, trailer, truncated };
}

const SCAN_CHUNK = 1 << 16;

async function findScanEnd(src: Reader, from: number): Promise<number> {
  let pos = from;
  while (pos < src.size) {
    const chunk = await src.bytes({ start: pos, end: Math.min(src.size, pos + SCAN_CHUNK) });
    for (let i = 0; i < chunk.length - 1; i++) {
      if (chunk[i] !== 0xff) continue;
      const next = chunk[i + 1]!;
      if (next === 0x00 || next === 0xff || isRst(next)) continue;
      return pos + i;
    }
    if (chunk.length < SCAN_CHUNK) break;
    pos += chunk.length - 1; // carry one byte so a split 0xFF/marker pair is seen
  }
  return src.size;
}

export function markerName(m: number): string {
  if (m === SOI) return "SOI";
  if (m === EOI) return "EOI";
  if (m === SOS) return "SOS";
  if (m === COM) return "COM";
  if (m === DQT) return "DQT";
  if (m === DHT) return "DHT";
  if (m === DRI) return "DRI";
  if (isApp(m)) return `APP${m - 0xe0}`;
  if (isSof(m)) return `SOF${m - 0xc0}`;
  if (isRst(m)) return `RST${m - 0xd0}`;
  return `0x${m.toString(16).toUpperCase()}`;
}

/** Markers a decoder needs. Everything else is droppable without touching pixels. */
export function isStructural(m: number): boolean {
  return (
    m === SOI ||
    m === EOI ||
    m === SOS ||
    m === DQT ||
    m === DHT ||
    m === DRI ||
    m === TEM ||
    isSof(m) ||
    isRst(m)
  );
}
