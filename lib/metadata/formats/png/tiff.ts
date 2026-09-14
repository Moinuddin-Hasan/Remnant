import exifr from "exifr";
import type { Finding } from "../../types";

/**
 * Tag and XMP readers shared by the formats that embed a raw TIFF/EXIF block
 * or an XMP packet inside their own container (PNG `eXIf`, WebP `EXIF`/`XMP `).
 *
 * Finding ids match the JPEG handler's (`exif.Make`, `exif.gps`) so the same
 * leak reads the same way whichever container it arrived in.
 */

const EXIF_PREFIX = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

/** Some writers prefix the TIFF block with the JPEG APP1 identifier. exifr rejects that. */
export function stripExifPrefix(b: Uint8Array): Uint8Array {
  return EXIF_PREFIX.every((v, i) => b[i] === v) ? b.subarray(EXIF_PREFIX.length) : b;
}

const TAG_MAP: ReadonlyArray<readonly [string, string, Finding["group"], Finding["severity"]]> = [
  ["Make", "Camera make", "device", "notable"],
  ["Model", "Camera model", "device", "notable"],
  ["LensModel", "Lens", "device", "notable"],
  ["BodySerialNumber", "Camera body serial number", "device", "critical"],
  ["SerialNumber", "Serial number", "device", "critical"],
  ["LensSerialNumber", "Lens serial number", "device", "critical"],
  ["Software", "Software", "software", "benign"],
  ["DateTimeOriginal", "Capture time", "time", "notable"],
  ["CreateDate", "Created", "time", "notable"],
  ["ModifyDate", "Modified", "time", "notable"],
  ["OffsetTimeOriginal", "Timezone offset", "time", "notable"],
  ["Artist", "Artist", "identity", "critical"],
  ["Copyright", "Copyright", "identity", "notable"],
  ["OwnerName", "Owner name", "identity", "critical"],
  ["HostComputer", "Host computer", "identity", "critical"],
  ["UserComment", "User comment", "identity", "notable"],
];

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(fmt).filter(Boolean).join(", ");
  if (typeof v === "object") return "";
  return String(v);
};

export const gpsValue = (lat: number, lon: number): string =>
  `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

/** Parse a raw TIFF block (optionally `Exif\0\0`-prefixed) into findings. Never throws. */
export async function tiffFindings(block: Uint8Array): Promise<Finding[]> {
  const tiff = stripExifPrefix(block).slice();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = (await exifr.parse(tiff, {
      tiff: true,
      exif: true,
      gps: true,
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
  const { latitude, longitude } = parsed;
  if (typeof latitude === "number" && typeof longitude === "number") {
    findings.push({
      id: "exif.gps",
      label: "GPS coordinates",
      value: gpsValue(latitude, longitude),
      group: "location",
      severity: "critical",
    });
  }
  return findings;
}

/** An XMP property as either `ns:Name="v"` or `<ns:Name>v</ns:Name>`, including a first `rdf:li`. */
function xmpProp(xml: string, name: string): string | undefined {
  const esc = name.replace(":", "\\:");
  const attr = new RegExp(`${esc}\\s*=\\s*"([^"]*)"`).exec(xml);
  if (attr?.[1]) return attr[1].trim();
  const el = new RegExp(`<${esc}[^>]*>([\\s\\S]*?)</${esc}>`).exec(xml);
  if (!el?.[1]) return undefined;
  const li = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(el[1]);
  const v = (li?.[1] ?? el[1]).replace(/<[^>]+>/g, "").trim();
  return v || undefined;
}

/** XMP GPS is `DDD,MM,SSk` or `DDD,MM.mmk` where k is N/S/E/W. */
function xmpCoord(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?([NSEW])$/i.exec(v.trim());
  if (!m) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  const deg = Number(m[1]) + Number(m[2]) / 60 + Number(m[3] ?? 0) / 3600;
  return /[SW]/i.test(m[4]!) ? -deg : deg;
}

const XMP_MAP: ReadonlyArray<readonly [string, string, Finding["group"], Finding["severity"]]> = [
  ["dc:creator", "Creator", "identity", "critical"],
  ["tiff:Make", "Camera make", "device", "notable"],
  ["tiff:Model", "Camera model", "device", "notable"],
  ["xmp:CreatorTool", "Creator tool", "software", "notable"],
  ["xmp:CreateDate", "Created", "time", "notable"],
  ["photoshop:DateCreated", "Created", "time", "notable"],
  ["exif:DateTimeOriginal", "Capture time", "time", "notable"],
];

/** Pull the leaking properties out of an XMP packet. Ids are `xmp.*` so they never collide with EXIF. */
export function xmpFindings(xml: string): Finding[] {
  const findings: Finding[] = [];
  for (const [name, label, group, severity] of XMP_MAP) {
    const value = xmpProp(xml, name);
    if (value) findings.push({ id: `xmp.${name.split(":")[1]}`, label: `${label} (XMP)`, value, group, severity });
  }
  const lat = xmpCoord(xmpProp(xml, "exif:GPSLatitude"));
  const lon = xmpCoord(xmpProp(xml, "exif:GPSLongitude"));
  if (lat !== undefined && lon !== undefined) {
    findings.push({
      id: "xmp.gps",
      label: "GPS coordinates (XMP)",
      value: gpsValue(lat, lon),
      group: "location",
      severity: "critical",
    });
  }
  return findings;
}
