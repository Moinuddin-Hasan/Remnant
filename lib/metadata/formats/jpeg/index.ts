import exifr from "exifr";
import type { FormatHandler, SpoofProfile } from "../../handler";
import { drop, planOf, replace, type Edit } from "../../patch";
import { buildExifApp1 } from "./exif-write";
import type { Reader } from "../../reader";
import type { EmbeddedAsset, Finding, Report, StripOptions } from "../../types";
import { parseMpf } from "./mpf";
import { inspectTrailer } from "./trailer";
import {
  COM,
  isApp,
  isStructural,
  markerName,
  walkJpeg,
  type Segment,
} from "./segments";

const EXIF_HEAD_BYTES = 1 << 20; // 1 MB is far more than any APP segment run

/** APP identifiers we can name for the user. Anything else is reported generically. */
const APP_LABELS: ReadonlyArray<readonly [string, string, string]> = [
  ["Exif", "exif", "EXIF block"],
  ["http://ns.adobe.com/xap/1.0/", "xmp", "XMP packet"],
  ["http://ns.adobe.com/xmp/extension/", "xmp.ext", "Extended XMP packet"],
  ["Photoshop 3.0", "iptc", "Photoshop/IPTC resource block"],
  ["ICC_PROFILE", "icc", "ICC colour profile"],
  ["MPF", "mpf", "Multi-Picture Format index"],
  ["Adobe", "adobe", "Adobe APP14 marker"],
  ["JFIF", "jfif", "JFIF header"],
  ["http://ns.google.com/photos/1.0/", "gcam", "Google camera XMP"],
];

function labelFor(seg: Segment): { id: string; label: string } {
  const ident = seg.identifier ?? "";
  for (const [prefix, id, label] of APP_LABELS) {
    if (ident.startsWith(prefix)) return { id: `jpeg.${id}`, label };
  }
  if (seg.marker === COM) return { id: "jpeg.comment", label: "JPEG comment" };
  return {
    id: `jpeg.${markerName(seg.marker).toLowerCase()}`,
    label: `${markerName(seg.marker)} segment${ident ? ` (${ident})` : ""}`,
  };
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(fmt).filter(Boolean).join(", ");
  if (typeof v === "object") return "";
  return String(v);
};

/** Tags worth naming individually, with the group and severity we assign them. */
const TAG_MAP: ReadonlyArray<
  readonly [string, string, Finding["group"], Finding["severity"]]
> = [
  ["Make", "Camera make", "device", "notable"],
  ["Model", "Camera model", "device", "notable"],
  ["LensModel", "Lens", "device", "notable"],
  ["BodySerialNumber", "Camera body serial number", "device", "critical"],
  ["SerialNumber", "Serial number", "device", "critical"],
  ["LensSerialNumber", "Lens serial number", "device", "critical"],
  ["InternalSerialNumber", "Internal serial number", "device", "critical"],
  ["Software", "Software", "software", "benign"],
  ["DateTimeOriginal", "Capture time", "time", "notable"],
  ["CreateDate", "Created", "time", "notable"],
  ["ModifyDate", "Modified", "time", "notable"],
  ["OffsetTimeOriginal", "Timezone offset", "time", "notable"],
  ["Artist", "Artist", "identity", "critical"],
  ["Copyright", "Copyright", "identity", "notable"],
  ["OwnerName", "Owner name", "identity", "critical"],
  ["HostComputer", "Host computer", "identity", "critical"],
  ["ImageDescription", "Description", "identity", "benign"],
  ["UserComment", "User comment", "identity", "notable"],
];

async function readTags(src: Reader): Promise<Finding[]> {
  const head = await src.bytes({ start: 0, end: Math.min(src.size, EXIF_HEAD_BYTES) });
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = (await exifr.parse(head, {
      tiff: true,
      exif: true,
      gps: true,
      iptc: true,
      xmp: true,
      icc: false,
      mergeOutput: true,
      translateValues: true,
      reviveValues: true,
    })) as Record<string, unknown> | undefined;
  } catch {
    return [];
  }
  if (!parsed) return [];

  const findings: Finding[] = [];

  for (const [key, label, group, severity] of TAG_MAP) {
    const value = fmt(parsed[key]);
    if (value) findings.push({ id: `exif.${key}`, label, value, group, severity });
  }

  const lat = parsed.latitude;
  const lon = parsed.longitude;
  if (typeof lat === "number" && typeof lon === "number") {
    findings.push({
      id: "exif.gps",
      label: "GPS coordinates",
      value: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
      group: "location",
      severity: "critical",
    });
  }

  return findings;
}

async function inspect(src: Reader): Promise<Report> {
  const structure = await walkJpeg(src);
  const findings: Finding[] = [];
  const assets: EmbeddedAsset[] = [];
  const unhandled: string[] = [];

  if (structure.truncated) {
    unhandled.push("The marker chain ended unexpectedly — this file may be truncated or malformed.");
  }

  // Segment-level findings: what is physically present, with byte ranges.
  for (const seg of structure.segments) {
    if (!isApp(seg.marker) && seg.marker !== COM) continue;
    const { id, label } = labelFor(seg);
    const bytes = seg.end - seg.start;
    findings.push({
      id,
      label,
      value: `${bytes.toLocaleString()} bytes at offset ${seg.start.toLocaleString()}`,
      group: id.includes("icc") || id.includes("jfif") ? "software" : "history",
      severity: id.includes("jfif") ? "benign" : "notable",
      range: { start: seg.start, end: seg.end },
    });

    if ((seg.identifier ?? "").startsWith("MPF")) {
      const { assets: mpfAssets } = await parseMpf(src, seg);
      assets.push(...mpfAssets);
    }
  }

  // Tag-level findings: what those segments actually say.
  findings.push(...(await readTags(src)));

  // The EXIF thumbnail — kept as the secondary reveal behind MPF and the trailer.
  try {
    const head = await src.bytes({ start: 0, end: Math.min(src.size, EXIF_HEAD_BYTES) });
    const thumb = await exifr.thumbnail(head);
    if (thumb && thumb.byteLength > 0) {
      assets.push({
        kind: "thumbnail",
        mime: "image/jpeg",
        range: { start: 0, end: 0 }, // located inside APP1; extracted via exifr, not by offset
        note:
          `An EXIF thumbnail (${Math.round(thumb.byteLength / 1024)} KB) is embedded in this ` +
          `file. If the photo was cropped by a tool that did not regenerate it, this thumbnail ` +
          `still shows the original frame.`,
      });
    }
  } catch {
    unhandled.push("Embedded thumbnail could not be decoded.");
  }

  // Everything after EOI is "after the image", but MPF images legitimately live
  // there too and are already reported above. Reporting the raw post-EOI span
  // as well would count the same bytes twice, so the trailer is only what the
  // MPF index does not account for.
  if (structure.trailer) {
    const claimed = assets.reduce(
      (max, a) => (a.kind === "second-image" ? Math.max(max, a.range.end) : max),
      structure.trailer.start,
    );
    const effective = claimed < src.size ? { start: claimed, end: src.size } : null;

    if (effective) {
      const t = await inspectTrailer(src, effective);
      if (t) {
        assets.push(t.asset);
        findings.push({
          id: "jpeg.trailer",
          label: `Data after end-of-image (${t.kindLabel})`,
          value: `${(effective.end - effective.start).toLocaleString()} bytes`,
          group: "remnant",
          severity: "critical",
          range: effective,
        });
      }
    }
  }

  unhandled.push(
    "Quantization tables, Huffman tables and chroma subsampling identify the encoder and are " +
      "not removable — they are the image.",
  );

  return {
    format: "jpeg",
    formatLabel: "JPEG image",
    tier: 2,
    size: src.size,
    findings,
    assets,
    unhandled,
  };
}

/**
 * Whitelist strip: keep the markers a decoder needs, drop everything else,
 * truncate at EOI.
 *
 * Dropping whole segments never touches the entropy-coded scan, so the decoded
 * pixels are bit-identical to the original. That is the difference between
 * this and a canvas re-encode, and it is why we can claim the image is
 * untouched.
 */
async function plan(src: Reader, _report: Report, opts: StripOptions): Promise<Edit> {
  const structure = await walkJpeg(src);
  const patches = [];

  for (const seg of structure.segments) {
    if (isStructural(seg.marker)) continue;
    const ident = seg.identifier ?? "";
    if (opts.keepColorProfile && ident.startsWith("ICC_PROFILE")) continue;
    // JFIF carries density/aspect only and some decoders expect it.
    if (ident.startsWith("JFIF")) continue;
    patches.push(drop({ start: seg.start, end: seg.end }));
  }

  if (structure.trailer) {
    patches.push(drop(structure.trailer));
  }

  return { kind: "patch", plan: planOf(patches) };
}

/**
 * Write a forged identity onto the file.
 *
 * Goes through the same patch engine the stripper uses, so there is exactly
 * one write path and one corruption mode. An existing Exif APP1 is replaced in
 * place; when there is none, the new segment is inserted directly after SOI as
 * a zero-length replace.
 *
 * Any OTHER metadata segment is dropped first. Leaving an old XMP packet that
 * still names the real camera beside a forged EXIF block is the single most
 * obvious contradiction a file can carry, and the linter would immediately
 * flag our own output.
 */
async function spoof(src: Reader, _report: Report, profile: SpoofProfile): Promise<Edit> {
  const structure = await walkJpeg(src);
  const app1 = buildExifApp1(profile);
  const patches = [];

  let placed = false;
  for (const seg of structure.segments) {
    if (isStructural(seg.marker)) continue;
    const ident = seg.identifier ?? "";
    if (ident.startsWith("JFIF")) continue;

    if (!placed && ident.startsWith("Exif")) {
      patches.push(replace({ start: seg.start, end: seg.end }, app1));
      placed = true;
      continue;
    }
    patches.push(drop({ start: seg.start, end: seg.end }));
  }

  if (!placed) {
    // Zero-length range at offset 2 = insert immediately after SOI.
    patches.unshift(replace({ start: 2, end: 2 }, app1));
  }

  if (structure.trailer) patches.push(drop(structure.trailer));

  patches.sort((a, b) => a.range.start - b.range.start);
  return { kind: "patch", plan: planOf(patches) };
}

export const jpegHandler: FormatHandler = {
  id: "jpeg",
  label: "JPEG image",
  sniff: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  inspect,
  plan,
  spoof,
};
