import type { Reader } from "../../reader";
import type { EmbeddedAsset, Finding } from "../../types";
import { gpsValue, xmpFindings } from "../png/tiff";
import { parseIso6709, type Box } from "./boxes";

/**
 * Readers for the three places ISOBMFF writers put descriptive metadata:
 *   - QuickTime user-data atoms in `udta` (`©xyz`, `©mak`, `©mod`, …)
 *   - `meta` boxes holding `keys` + `ilst` (Apple `mdta`) or iTunes-style `ilst`
 *   - `uuid` boxes, notably Adobe's XMP uuid
 */

type Class = readonly [string, Finding["group"], Finding["severity"]];

const MAX_VALUE = 300;
const clip = (s: string): string => (s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s);
const bytesAt = (b: Box) =>
  `${(b.end - b.start).toLocaleString()} bytes at offset ${b.start.toLocaleString()}`;

/** QuickTime/iTunes atom codes. `©xyz` is GPS and handled separately. */
const ATOMS: Record<string, Class> = {
  "©mak": ["Camera make", "device", "notable"],
  "©mod": ["Camera model", "device", "notable"],
  "©swr": ["Software", "software", "notable"],
  "©too": ["Encoder", "software", "notable"],
  "©enc": ["Encoded by", "identity", "notable"],
  "©day": ["Recorded", "time", "notable"],
  "©nam": ["Title", "identity", "notable"],
  "©ART": ["Artist", "identity", "critical"],
  "©aut": ["Author", "identity", "critical"],
  "©cmt": ["Comment", "identity", "notable"],
  "©des": ["Description", "identity", "notable"],
  "©inf": ["Information", "history", "notable"],
  "©cpy": ["Copyright", "identity", "notable"],
  desc: ["Description", "identity", "notable"],
  cprt: ["Copyright", "identity", "notable"],
  auth: ["Author", "identity", "critical"],
};

/** Vendor atoms seen in `udta` from action cameras and phones. */
const PRIVATE: Record<string, Class> = {
  FIRM: ["Camera firmware (GoPro)", "software", "notable"],
  LENS: ["Lens identifier (GoPro)", "device", "notable"],
  CAME: ["Camera unique identifier (GoPro)", "device", "critical"],
  MUID: ["Media unique identifier (GoPro)", "identity", "notable"],
  GPMF: ["GoPro metadata stream settings", "device", "notable"],
  SETT: ["Capture settings (GoPro)", "device", "notable"],
  smta: ["Samsung metadata atom", "device", "notable"],
  SDLN: ["Samsung device line", "device", "notable"],
};

/** Classify an `mdta` key such as `com.apple.quicktime.model`. */
function classifyKey(key: string): Class | "gps" {
  const k = key.toLowerCase();
  if (k.endsWith("location.iso6709") || k === "location" || k === "com.android.capture.location") return "gps";
  if (k.includes("content.identifier")) return ["Live Photo pairing identifier", "identity", "notable"];
  if (/(^|\.)(make|manufacturer)$/.test(k)) return ["Camera make", "device", "notable"];
  if (/(^|\.)model$/.test(k)) return ["Camera model", "device", "notable"];
  if (/(software|encoder|version)$/.test(k)) return ["Software", "software", "notable"];
  if (/(creationdate|creation_time|date)$/.test(k)) return ["Recorded", "time", "notable"];
  if (/(author|artist|owner|displayname)$/.test(k)) return ["Author", "identity", "critical"];
  if (k.includes("location")) return ["Location detail", "location", "notable"];
  return [`Metadata key: ${key}`, "history", "notable"];
}

const gpsFinding = (lat: number, lon: number, source: string, b: Box): Finding => ({
  id: `mp4.gps.${b.start}`,
  label: `GPS coordinates (${source})`,
  value: gpsValue(lat, lon),
  group: "location",
  severity: "critical",
  range: { start: b.start, end: b.end },
});

const decode = (b: Uint8Array, enc = "utf-8"): string =>
  new TextDecoder(enc, { fatal: false }).decode(b).replace(/\0+$/, "");

type DataValue = { text: string } | { image: string; start: number; end: number };

/** An iTunes/`mdta` `data` box: type indicator, locale, value. */
async function dataValue(src: Reader, d: Box): Promise<DataValue> {
  const type = (await src.u32be(d.bodyStart)) & 0xffffff;
  const start = d.bodyStart + 8;
  const len = d.end - start;
  if (type === 13 || type === 14) return { image: type === 13 ? "image/jpeg" : "image/png", start, end: d.end };
  const v = await src.bytes({ start, end: Math.min(d.end, start + 4096) });
  if (type === 1) return { text: decode(v) };
  if (type === 2) return { text: decode(v, "utf-16be") };
  if ((type === 21 || type === 22) && len <= 4) {
    let n = 0;
    for (const x of v) n = n * 256 + x;
    return { text: String(n) };
  }
  if (type === 23 && len === 4) return { text: String(new DataView(v.buffer, v.byteOffset).getFloat32(0)) };
  return { text: `${len.toLocaleString()} bytes (type ${type})` };
}

function classified(id: string, [label, group, severity]: Class, value: string, b: Box): Finding {
  return { id, label, value: clip(value), group, severity, range: { start: b.start, end: b.end } };
}

/** 3GPP `loci`: name, role, then longitude/latitude/altitude as signed 16.16 fixed point. */
async function lociFinding(src: Reader, b: Box): Promise<Finding | null> {
  const body = await src.bytes({ start: b.bodyStart, end: Math.min(b.end, b.bodyStart + 512) });
  let p = 6; // FullBox header + packed language
  if (body[p] === 0xfe && body[p + 1] === 0xff) {
    p += 2;
    while (p + 1 < body.length && (body[p] !== 0 || body[p + 1] !== 0)) p += 2;
    p += 2;
  } else {
    while (p < body.length && body[p] !== 0) p++;
    p += 1;
  }
  p += 1; // role
  if (p + 8 > body.length) return null;
  const dv = new DataView(body.buffer, body.byteOffset);
  const lon = dv.getInt32(p) / 65536;
  const lat = dv.getInt32(p + 4) / 65536;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return gpsFinding(lat, lon, "3GPP loci", b);
}

/** A QuickTime string atom: `len:2 | lang:2 | text`, or iTunes-style with a `data` child. */
async function atomText(src: Reader, b: Box): Promise<string> {
  const data = b.children.find((c) => c.type === "data");
  if (data) {
    const v = await dataValue(src, data);
    return "text" in v ? v.text : "(image)";
  }
  const len = await src.u16be(b.bodyStart);
  const from = b.bodyStart + 4;
  return decode(await src.bytes({ start: from, end: Math.min(b.end, from + len, from + 4096) }));
}

/** One direct child of a `udta` box. `meta` children are handled by metaFindings. */
export async function udtaChildFindings(src: Reader, b: Box): Promise<Finding[]> {
  if (b.type === "meta" || b.type === "free" || b.type === "skip") return [];
  if (b.type === "©xyz") {
    const p = parseIso6709(await atomText(src, b));
    return p ? [gpsFinding(p.lat, p.lon, "©xyz", b)] : [];
  }
  if (b.type === "loci") {
    const f = await lociFinding(src, b);
    return f ? [f] : [];
  }
  const atom = ATOMS[b.type];
  if (atom) return [classified(`mp4.${b.type}.${b.start}`, atom, await atomText(src, b), b)];
  const priv = PRIVATE[b.type];
  if (priv) return [classified(`mp4.${b.type}.${b.start}`, priv, bytesAt(b), b)];
  return [
    classified(
      `mp4.udta.${b.start}`,
      [`Unrecognised user-data atom "${b.type.trim()}"`, "history", "notable"],
      bytesAt(b),
      b,
    ),
  ];
}

async function keyNames(src: Reader, keys: Box): Promise<string[]> {
  const names: string[] = [];
  const count = await src.u32be(keys.bodyStart + 4);
  let at = keys.bodyStart + 8;
  for (let i = 0; i < count && at + 8 <= keys.end; i++) {
    const size = await src.u32be(at);
    if (size < 8 || at + size > keys.end) break;
    names.push(decode(await src.bytes({ start: at + 8, end: at + size })));
    at += size;
  }
  return names;
}

/** `meta` with `keys` + `ilst` (Apple mdta) or a bare iTunes `ilst`. */
export async function metaFindings(
  src: Reader,
  meta: Box,
): Promise<{ findings: Finding[]; assets: EmbeddedAsset[] }> {
  const findings: Finding[] = [];
  const assets: EmbeddedAsset[] = [];
  const keys = meta.children.find((c) => c.type === "keys");
  const names = keys ? await keyNames(src, keys) : [];
  const ilst = meta.children.find((c) => c.type === "ilst");

  for (const item of ilst?.children ?? []) {
    const data = item.children.find((c) => c.type === "data");
    if (!data) continue;
    // mdta items are typed by a 1-based index into `keys`; iTunes items by atom code.
    const index = await src.u32be(item.start + 4);
    const key = names.length && index >= 1 && index <= names.length ? names[index - 1]! : item.type;
    const v = await dataValue(src, data);

    if ("image" in v) {
      assets.push({
        kind: "second-image",
        mime: v.image,
        range: { start: v.start, end: v.end },
        note: `An image is embedded as "${key.trim()}" artwork. Cover art is often a personal photo.`,
      });
      findings.push(classified(`mp4.art.${item.start}`, ["Embedded artwork", "remnant", "critical"], bytesAt(item), item));
      continue;
    }

    const cls = names.length ? classifyKey(key) : (ATOMS[key] ?? classifyKey(key));
    if (cls === "gps") {
      const p = parseIso6709(v.text);
      if (p) findings.push(gpsFinding(p.lat, p.lon, names.length ? key : "ilst", item));
      continue;
    }
    findings.push(classified(`mp4.key.${item.start}`, cls, v.text, item));
  }
  return { findings, assets };
}

const XMP_UUID = "be7acfcb97a942e89c71999491e3afac";

export async function uuidFindings(src: Reader, b: Box): Promise<Finding[]> {
  const id = await src.bytes({ start: b.bodyStart, end: Math.min(b.end, b.bodyStart + 16) });
  const hex = Array.from(id, (x) => x.toString(16).padStart(2, "0")).join("");
  if (hex === XMP_UUID) {
    const xml = decode(await src.bytes({ start: b.bodyStart + 16, end: Math.min(b.end, b.bodyStart + 16 + (1 << 20)) }));
    return [
      classified(`mp4.xmp.${b.start}`, ["XMP packet (uuid box)", "history", "notable"], bytesAt(b), b),
      ...xmpFindings(xml),
    ];
  }
  return [classified(`mp4.uuid.${b.start}`, [`Vendor uuid box ${hex.slice(0, 8)}…`, "history", "notable"], bytesAt(b), b)];
}
