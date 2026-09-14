import type { FormatHandler, SpoofProfile } from "../../handler";
import { drop, planOf, replace, type Edit, type Patch } from "../../patch";
import type { Reader } from "../../reader";
import type { ByteRange, EmbeddedAsset, Finding, Report, StripOptions } from "../../types";
import { buildTiff } from "../jpeg/exif-write";
import { tiffFindings, xmpFindings } from "../png/tiff";

/**
 * WebP: `RIFF | size:4 LE | WEBP`, then `fourcc:4 | size:4 LE | data | pad`.
 * Sizes are little-endian and every odd-length payload is followed by one pad
 * byte that the size field does not count.
 *
 * Dropping a chunk is not enough on its own. The extended header (VP8X) holds
 * a flag bit per optional feature, and the outer RIFF size covers everything.
 * Leave a flag set for a chunk that is gone, or the RIFF size stale, and strict
 * decoders reject the file while Chrome still shows it — so both are patched in
 * the same plan as the drops.
 */

const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

/** Chunks a decoder needs. Everything else in the container is optional. */
const IMAGE_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);

export interface WebpChunk {
  readonly fourcc: string;
  readonly start: number;
  /** End including the pad byte. */
  readonly end: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

export interface WebpStructure {
  readonly riffSize: number;
  readonly chunks: readonly WebpChunk[];
  /** Bytes after the end the RIFF header declares. */
  readonly trailer: ByteRange | null;
  /** Bytes inside the declared RIFF that do not form a valid chunk. */
  readonly unparsed: ByteRange | null;
  /** The RIFF header claims more bytes than the file has. */
  readonly short: boolean;
}

export async function walkWebp(src: Reader): Promise<WebpStructure> {
  const riffSize = await src.u32le(4);
  const riffEnd = Math.min(8 + riffSize, src.size);
  const chunks: WebpChunk[] = [];
  let at = 12;
  while (at + 8 <= riffEnd) {
    const fourcc = await src.ascii({ start: at, end: at + 4 });
    const len = await src.u32le(at + 4);
    const dataEnd = at + 8 + len;
    if (!/^[\x20-\x7e]{4}$/.test(fourcc) || dataEnd > riffEnd) break;
    // Tolerate a missing pad byte on the very last chunk; some writers omit it.
    const end = Math.min(dataEnd + (len & 1), riffEnd);
    chunks.push({ fourcc, start: at, end, dataStart: at + 8, dataEnd });
    at = end;
  }
  return {
    riffSize,
    chunks,
    trailer: 8 + riffSize < src.size ? { start: 8 + riffSize, end: src.size } : null,
    unparsed: at < riffEnd ? { start: at, end: riffEnd } : null,
    short: 8 + riffSize > src.size,
  };
}

const size = (c: WebpChunk): string =>
  `${(c.end - c.start).toLocaleString()} bytes at offset ${c.start.toLocaleString()}`;

async function chunkFindings(src: Reader, c: WebpChunk, idx: number): Promise<Finding[]> {
  const range = { start: c.start, end: c.end };
  switch (c.fourcc) {
    case "EXIF": {
      const data = await src.bytes({ start: c.dataStart, end: c.dataEnd });
      return [
        { id: `webp.EXIF.${idx}`, label: "EXIF block", value: size(c), group: "history", severity: "notable", range },
        ...(await tiffFindings(data)),
      ];
    }
    case "XMP ": {
      const data = await src.bytes({ start: c.dataStart, end: c.dataEnd });
      return [
        { id: `webp.XMP.${idx}`, label: "XMP packet", value: size(c), group: "history", severity: "notable", range },
        ...xmpFindings(new TextDecoder().decode(data)),
      ];
    }
    case "ICCP":
      return [
        { id: `webp.ICCP.${idx}`, label: "ICC colour profile", value: size(c), group: "device", severity: "benign", range },
      ];
    default:
      return [
        {
          id: `webp.chunk.${idx}`,
          label: `Unrecognised chunk "${c.fourcc.trim()}"`,
          value: size(c),
          group: "history",
          severity: "notable",
          range,
        },
      ];
  }
}

async function inspect(src: Reader): Promise<Report> {
  const s = await walkWebp(src);
  const findings: Finding[] = [];
  const assets: EmbeddedAsset[] = [];
  const unhandled: string[] = [];

  for (const [i, c] of s.chunks.entries()) {
    if (IMAGE_CHUNKS.has(c.fourcc)) continue;
    findings.push(...(await chunkFindings(src, c, i)));
  }

  if (s.trailer) {
    const len = s.trailer.end - s.trailer.start;
    findings.push({
      id: "webp.trailer",
      label: "Data after the end of the WebP container",
      value: `${len.toLocaleString()} bytes`,
      group: "remnant",
      severity: "critical",
      range: s.trailer,
    });
    assets.push({
      kind: "trailer-data",
      mime: "application/octet-stream",
      range: s.trailer,
      note:
        `${Math.max(1, Math.round(len / 1024))} KB of data sits after the end the RIFF header ` +
        `declares. No decoder reads it, but it travels with the file.`,
    });
  }

  if (s.unparsed) {
    findings.push({
      id: "webp.unparsed",
      label: "Unparsed bytes inside the container",
      value: `${(s.unparsed.end - s.unparsed.start).toLocaleString()} bytes at offset ${s.unparsed.start.toLocaleString()}`,
      group: "remnant",
      severity: "notable",
      range: s.unparsed,
    });
    unhandled.push("The chunk chain broke before the declared end — these bytes were not parsed and are not removed.");
  }
  if (s.short) {
    unhandled.push("The RIFF header claims more bytes than the file contains — this file is truncated.");
  }
  if (s.chunks.some((c) => c.fourcc === "ANMF")) {
    unhandled.push("Animated WebP: frame chunks are kept exactly as they are.");
  }
  unhandled.push(
    "Pixels are not examined. Anything visible in the image itself is untouched by a metadata strip.",
  );

  const seen = new Set<string>();
  const unique = findings.filter((f) => !seen.has(f.id) && (seen.add(f.id), true));

  return { format: "webp", formatLabel: "WebP image", tier: 2, size: src.size, findings: unique, assets, unhandled };
}

const u32le = (v: number): Uint8Array =>
  new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

/**
 * Drop EXIF, XMP, unknown chunks and ICCP (unless kept), then in the same plan
 * clear the matching VP8X flag bits and rewrite the RIFF size. Image chunks are
 * never touched, so the VP8/VP8L bitstream comes out byte-identical.
 */
async function plan(src: Reader, _report: Report, opts: StripOptions): Promise<Edit> {
  const s = await walkWebp(src);
  const patches: Patch[] = [];
  let removed = 0;
  let clear = 0;

  for (const c of s.chunks) {
    if (IMAGE_CHUNKS.has(c.fourcc)) continue;
    if (c.fourcc === "ICCP" && opts.keepColorProfile) continue;
    patches.push(drop({ start: c.start, end: c.end }));
    removed += c.end - c.start;
    if (c.fourcc === "EXIF") clear |= FLAG_EXIF;
    if (c.fourcc === "XMP ") clear |= FLAG_XMP;
    if (c.fourcc === "ICCP") clear |= FLAG_ICC;
  }

  const vp8x = s.chunks.find((c) => c.fourcc === "VP8X");
  if (vp8x && vp8x.dataEnd > vp8x.dataStart) {
    const flags = await src.u8(vp8x.dataStart);
    // Also clear any bit whose chunk was never there: a stale flag on the
    // input would otherwise survive the clean.
    const present = new Set(s.chunks.map((c) => c.fourcc));
    let next = flags & ~clear;
    if (!present.has("EXIF")) next &= ~FLAG_EXIF;
    if (!present.has("XMP ")) next &= ~FLAG_XMP;
    if (!present.has("ICCP")) next &= ~FLAG_ICC;
    if (next !== flags) {
      patches.push(replace({ start: vp8x.dataStart, end: vp8x.dataStart + 1 }, new Uint8Array([next])));
    }
  }

  if (removed > 0) patches.push(replace({ start: 4, end: 8 }, u32le(s.riffSize - removed)));
  if (s.trailer) patches.push(drop(s.trailer));

  return { kind: "patch", plan: planOf(patches) };
}

const FLAG_ALPHA = 0x10;

/**
 * Order patches by offset, and put a zero-length insert ahead of a drop that
 * starts at the same offset — otherwise the insert lands inside the drop and
 * validatePlan rightly rejects it. The engine's own sort is stable, so this
 * order survives it.
 */
export const byStartInsertsFirst = (a: Patch, b: Patch): number =>
  a.range.start - b.range.start || (a.range.end - a.range.start) - (b.range.end - b.range.start);

const riffChunk = (fourcc: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + data.length + (data.length & 1)); // pad byte stays zero
  for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i) & 0xff;
  out.set(u32le(data.length), 4);
  out.set(data, 8);
  return out;
};

const u24le = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];

/**
 * A simple-format WebP (bare `VP8 ` or `VP8L`) has no extended header, and
 * EXIF is only legal in the extended format. Build a VP8X from the canvas size
 * in the bitstream header so the forged EXIF has somewhere legal to live.
 */
async function vp8xFor(src: Reader, s: WebpStructure): Promise<Uint8Array> {
  const img = s.chunks.find((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L");
  if (!img) throw new Error("This WebP has no image bitstream to attach an identity to.");
  const d = await src.bytes({ start: img.dataStart, end: Math.min(img.dataEnd, img.dataStart + 10) });
  let w: number;
  let h: number;
  let alpha = false;
  if (img.fourcc === "VP8 ") {
    if (d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Error("VP8 start code missing.");
    w = (d[6]! | (d[7]! << 8)) & 0x3fff;
    h = (d[8]! | (d[9]! << 8)) & 0x3fff;
  } else {
    if (d[0] !== 0x2f) throw new Error("VP8L signature missing.");
    const bits = (d[1]! | (d[2]! << 8) | (d[3]! << 16) | (d[4]! << 24)) >>> 0;
    w = (bits & 0x3fff) + 1;
    h = ((bits >>> 14) & 0x3fff) + 1;
    alpha = ((bits >>> 28) & 1) === 1;
  }
  const payload = new Uint8Array([FLAG_EXIF | (alpha ? FLAG_ALPHA : 0), 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);
  return riffChunk("VP8X", payload);
}

/**
 * Write a forged identity as an `EXIF` chunk (a bare TIFF block) placed after
 * the image data, where the extended format puts it. Every other optional
 * chunk is dropped, the VP8X EXIF flag is SET (and ICC/XMP cleared), and the
 * RIFF size is rewritten — all in one patch plan.
 */
async function spoof(src: Reader, _report: Report, profile: SpoofProfile): Promise<Edit> {
  const s = await walkWebp(src);
  const lastImage = [...s.chunks].reverse().find((c) => IMAGE_CHUNKS.has(c.fourcc) && c.fourcc !== "VP8X");
  if (!lastImage) throw new Error("This WebP has no image data to attach an identity to.");

  const exif = riffChunk("EXIF", buildTiff(profile));
  const patches: Patch[] = [];
  let delta = exif.length;

  for (const c of s.chunks) {
    if (IMAGE_CHUNKS.has(c.fourcc)) continue;
    patches.push(drop({ start: c.start, end: c.end }));
    delta -= c.end - c.start;
  }

  const vp8x = s.chunks.find((c) => c.fourcc === "VP8X");
  if (vp8x) {
    const flags = await src.u8(vp8x.dataStart);
    const next = (flags | FLAG_EXIF) & ~FLAG_XMP & ~FLAG_ICC;
    if (next !== flags) {
      patches.push(replace({ start: vp8x.dataStart, end: vp8x.dataStart + 1 }, new Uint8Array([next])));
    }
  } else {
    const header = await vp8xFor(src, s);
    patches.push(replace({ start: 12, end: 12 }, header));
    delta += header.length;
  }

  patches.push(replace({ start: 4, end: 8 }, u32le(s.riffSize + delta)));
  patches.push(replace({ start: lastImage.end, end: lastImage.end }, exif));
  if (s.trailer) patches.push(drop(s.trailer));

  patches.sort(byStartInsertsFirst);
  return { kind: "patch", plan: planOf(patches) };
}

export const webpHandler: FormatHandler = {
  id: "webp",
  label: "WebP image",
  sniff: (head) =>
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && // RIFF
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50, // WEBP
  inspect,
  plan,
  spoof,
};
