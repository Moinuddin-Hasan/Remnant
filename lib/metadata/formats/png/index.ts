import type { FormatHandler } from "../../handler";
import { drop, planOf, type Edit, type Patch } from "../../patch";
import type { Reader } from "../../reader";
import type { ByteRange, EmbeddedAsset, Finding, Report, StripOptions } from "../../types";
import { stripExifPrefix, tiffFindings, xmpFindings } from "./tiff";

/**
 * PNG: an 8-byte signature, then `length:4 BE | type:4 | data | crc:4` chunks.
 *
 * Every chunk carries its own CRC over its own type and data, so deleting a
 * whole chunk leaves every surviving CRC valid. The strip is therefore pure
 * range drops — no CRC32, no recompression, and the IDAT stream is untouched.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const INFLATE_LIMIT = 1 << 20;
const MAX_VALUE = 300;

/**
 * Ancillary chunks that change how the image looks or animates. Kept on strip.
 * `acTL`/`fcTL`/`fdAT` are APNG: ancillary by the letter-case rule, but dropping
 * them flattens an animation to its first frame.
 */
const RENDERING = new Set([
  "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "bKGD", "pHYs", "hIST", "sPLT",
  "cICP", "mDCV", "mDCv", "cLLI", "cLLi", "acTL", "fcTL", "fdAT",
]);

const KNOWN_PRIVATE: Record<string, string> = {
  iDOT: "Apple iDOT chunk (written by macOS/iOS screenshots)",
  caNv: "Canva canvas chunk",
  vpAg: "ImageMagick virtual-page chunk",
  orNT: "Orientation chunk",
};

export interface PngChunk {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

export interface PngStructure {
  readonly chunks: readonly PngChunk[];
  /** Bytes after IEND. */
  readonly trailer: ByteRange | null;
  /** Bytes after a broken chunk chain that we could not parse. */
  readonly unparsed: ByteRange | null;
}

const isAncillary = (type: string): boolean => (type.charCodeAt(0) & 0x20) !== 0;

export async function walkPng(src: Reader): Promise<PngStructure> {
  const chunks: PngChunk[] = [];
  let at = SIGNATURE.length;
  let sawEnd = false;
  while (at + 12 <= src.size) {
    const len = await src.u32be(at);
    const type = await src.ascii({ start: at + 4, end: at + 8 });
    const end = at + 12 + len;
    if (!/^[A-Za-z]{4}$/.test(type) || end > src.size) break;
    chunks.push({ type, start: at, end, dataStart: at + 8, dataEnd: at + 8 + len });
    at = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  const rest = at < src.size ? { start: at, end: src.size } : null;
  return { chunks, trailer: sawEnd ? rest : null, unparsed: sawEnd ? null : rest };
}

/** zlib-inflate with a hard output cap, so a compressed text chunk cannot balloon memory. */
async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data.slice().buffer as ArrayBuffer])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
      if (total >= INFLATE_LIMIT) {
        await reader.cancel();
        break;
      }
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out.subarray(0, Math.min(total, INFLATE_LIMIT));
  } catch {
    return null;
  }
}

const latin1 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

const utf8 = (b: Uint8Array): string => new TextDecoder("utf-8", { fatal: false }).decode(b);

const clip = (s: string): string => (s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s);

/** Split a NUL-terminated field off the front. */
function field(b: Uint8Array, from = 0): { value: Uint8Array; next: number } {
  const nul = b.indexOf(0, from);
  return nul < 0
    ? { value: b.subarray(from), next: b.length }
    : { value: b.subarray(from, nul), next: nul + 1 };
}

const TEXT_KEYWORDS: Record<string, readonly [string, Finding["group"], Finding["severity"]]> = {
  Author: ["Author", "identity", "critical"],
  Artist: ["Artist", "identity", "critical"],
  Owner: ["Owner", "identity", "critical"],
  Copyright: ["Copyright", "identity", "notable"],
  Comment: ["Comment", "identity", "notable"],
  Description: ["Description", "identity", "notable"],
  Title: ["Title", "identity", "notable"],
  Software: ["Software", "software", "notable"],
  Source: ["Source device", "device", "notable"],
  "Creation Time": ["Creation time", "time", "notable"],
};

/**
 * ImageMagick stores EXIF inside a text chunk as hex: `\nexif\n  <len>\n<hex…>`.
 * Decode it so a PNG that went through `convert` still reports its GPS.
 */
function rawProfileBytes(text: string): Uint8Array | null {
  const lines = text.split("\n");
  if (lines.length < 4) return null;
  const hex = lines.slice(3).join("").replace(/\s+/g, "");
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function textFindings(
  keyword: string,
  text: string,
  range: ByteRange,
  idx: number,
): Promise<Finding[]> {
  if (keyword === "XML:com.adobe.xmp") {
    return [
      {
        id: `png.xmp.${idx}`,
        label: "XMP packet",
        value: `${text.length.toLocaleString()} characters`,
        group: "history",
        severity: "notable",
        range,
      },
      ...xmpFindings(text),
    ];
  }
  if (/^Raw profile type (exif|APP1)$/i.test(keyword)) {
    const bytes = rawProfileBytes(text);
    const tags = bytes ? await tiffFindings(stripExifPrefix(bytes)) : [];
    return [
      {
        id: `png.rawexif.${idx}`,
        label: "EXIF stored as a text chunk (ImageMagick raw profile)",
        value: `${text.length.toLocaleString()} characters`,
        group: "history",
        severity: "notable",
        range,
      },
      ...tags,
    ];
  }
  const [label, group, severity] = TEXT_KEYWORDS[keyword] ?? [keyword, "history", "notable"];
  return [{ id: `png.text.${idx}`, label: `Text: ${label}`, value: clip(text), group, severity, range }];
}

async function chunkFindings(src: Reader, c: PngChunk, idx: number): Promise<Finding[]> {
  const range = { start: c.start, end: c.end };
  const size = `${(c.end - c.start).toLocaleString()} bytes at offset ${c.start.toLocaleString()}`;

  if (RENDERING.has(c.type)) {
    return [
      {
        id: `png.${c.type}.${idx}`,
        label: `${c.type} chunk (rendering hint, kept)`,
        value: size,
        group: "software",
        severity: "benign",
        range,
      },
    ];
  }

  const data = await src.bytes({ start: c.dataStart, end: c.dataEnd });

  switch (c.type) {
    case "tEXt": {
      const k = field(data);
      return textFindings(latin1(k.value), latin1(data.subarray(k.next)), range, idx);
    }
    case "zTXt": {
      const k = field(data);
      const text = await inflate(data.subarray(k.next + 1)); // skip compression method byte
      return textFindings(latin1(k.value), text ? latin1(text) : "(could not decompress)", range, idx);
    }
    case "iTXt": {
      const k = field(data);
      const compressed = data[k.next] === 1;
      const lang = field(data, k.next + 2);
      const translated = field(data, lang.next);
      const raw = data.subarray(translated.next);
      const body = compressed ? await inflate(raw) : raw;
      return textFindings(latin1(k.value), body ? utf8(body) : "(could not decompress)", range, idx);
    }
    case "eXIf":
      return [
        {
          id: `png.eXIf.${idx}`,
          label: "EXIF block (eXIf chunk)",
          value: size,
          group: "history",
          severity: "notable",
          range,
        },
        ...(await tiffFindings(data)),
      ];
    case "tIME": {
      if (data.length < 7) return [];
      const y = (data[0]! << 8) | data[1]!;
      const p = (n: number) => String(n).padStart(2, "0");
      const iso = `${y}-${p(data[2]!)}-${p(data[3]!)}T${p(data[4]!)}:${p(data[5]!)}:${p(data[6]!)}Z`;
      return [{ id: `png.tIME.${idx}`, label: "Last modified (tIME)", value: iso, group: "time", severity: "notable", range }];
    }
    case "iCCP": {
      const name = latin1(field(data).value);
      return [
        {
          id: `png.iCCP.${idx}`,
          label: "ICC colour profile",
          value: `"${name}", ${size}`,
          group: "device",
          severity: "benign",
          range,
        },
      ];
    }
    default:
      return [
        {
          id: `png.${c.type}.${idx}`,
          label: KNOWN_PRIVATE[c.type] ?? `Unrecognised ancillary chunk "${c.type}"`,
          value: size,
          group: "history",
          severity: "notable",
          range,
        },
      ];
  }
}

const SIG_IDAT = new Uint8Array([0x49, 0x44, 0x41, 0x54]);
const SIG_IEND = new Uint8Array([0x49, 0x45, 0x4e, 0x44]);

/**
 * Bytes after IEND. A cropping tool that overwrites the original file without
 * truncating it leaves the tail of the ORIGINAL image's IDAT stream here —
 * aCropalypse (CVE-2023-21036 in Pixel Markup, CVE-2023-28303 in Windows
 * Snipping Tool). Enough of it survives to reconstruct much of the uncropped
 * screenshot.
 */
async function trailerFinding(
  src: Reader,
  t: ByteRange,
): Promise<{ finding: Finding; asset: EmbeddedAsset }> {
  const len = t.end - t.start;
  const leftover =
    (await src.find(SIG_IDAT, t.start, len)) >= 0 || (await src.find(SIG_IEND, t.start, len)) >= 0;
  const kb = Math.max(1, Math.round(len / 1024));
  return {
    finding: {
      id: "png.trailer",
      label: leftover
        ? "Leftover image data after end-of-image (aCropalypse pattern)"
        : "Data after end-of-image",
      value: `${len.toLocaleString()} bytes`,
      group: "remnant",
      severity: "critical",
      range: t,
    },
    asset: {
      kind: "trailer-data",
      mime: "application/octet-stream",
      range: t,
      note: leftover
        ? `${kb} KB of PNG chunk data follows the end-of-image marker. This is the aCropalypse ` +
          `pattern (CVE-2023-21036, CVE-2023-28303): a cropping or markup tool wrote the edited ` +
          `image over the original file without truncating it, so the tail of the original, ` +
          `uncropped image is still here and can be partially reconstructed.`
        : `${kb} KB of data sits after the end-of-image marker. No viewer renders it, but it ` +
          `travels with the file.`,
    },
  };
}

async function inspect(src: Reader): Promise<Report> {
  const structure = await walkPng(src);
  const findings: Finding[] = [];
  const assets: EmbeddedAsset[] = [];
  const unhandled: string[] = [];

  for (const [i, c] of structure.chunks.entries()) {
    if (!isAncillary(c.type)) continue;
    findings.push(...(await chunkFindings(src, c, i)));
  }

  if (structure.trailer) {
    const { finding, asset } = await trailerFinding(src, structure.trailer);
    findings.push(finding);
    assets.push(asset);
  }

  if (structure.unparsed) {
    const r = structure.unparsed;
    findings.push({
      id: "png.unparsed",
      label: "Unparsed bytes after a broken chunk chain",
      value: `${(r.end - r.start).toLocaleString()} bytes at offset ${r.start.toLocaleString()}`,
      group: "remnant",
      severity: "notable",
      range: r,
    });
    unhandled.push(
      "The chunk chain broke before IEND — this file is truncated or malformed. The bytes after " +
        "the break were not parsed and are not removed.",
    );
  }

  if (structure.chunks.some((c) => c.type === "acTL")) {
    unhandled.push("Animated PNG: frame chunks are kept exactly as they are.");
  }
  unhandled.push(
    "Pixels are not examined. Anything visible in the image itself — a face, a screen, a street " +
      "sign — is untouched by a metadata strip.",
  );

  // Tag-level ids repeat if a file carries the same tag twice (eXIf and a raw
  // profile, say). Ids are render keys, so keep the first of each.
  const seen = new Set<string>();
  const unique = findings.filter((f) => !seen.has(f.id) && (seen.add(f.id), true));

  return {
    format: "png",
    formatLabel: "PNG image",
    tier: 2,
    size: src.size,
    findings: unique,
    assets,
    unhandled,
  };
}

/**
 * Drop every ancillary chunk that is not a rendering hint, plus anything after
 * IEND. Critical chunks (uppercase first letter) are never touched, so IHDR,
 * PLTE and every IDAT byte come out identical.
 */
async function plan(src: Reader, _report: Report, opts: StripOptions): Promise<Edit> {
  const structure = await walkPng(src);
  const patches: Patch[] = [];
  for (const c of structure.chunks) {
    if (!isAncillary(c.type) || RENDERING.has(c.type)) continue;
    if (c.type === "iCCP" && opts.keepColorProfile) continue;
    patches.push(drop({ start: c.start, end: c.end }));
  }
  if (structure.trailer) patches.push(drop(structure.trailer));
  return { kind: "patch", plan: planOf(patches) };
}

export const pngHandler: FormatHandler = {
  id: "png",
  label: "PNG image",
  sniff: (head) => SIGNATURE.every((v, i) => head[i] === v),
  inspect,
  plan,
};
