import type { SpoofProfile } from "../../handler";

/**
 * Builds an APP1 / Exif segment from a profile.
 *
 * TIFF is strict about two things that are easy to get wrong and produce a
 * block every reader silently ignores: entries within an IFD must be in
 * ascending tag order, and any value longer than four bytes lives in a data
 * area with the entry holding an offset relative to the TIFF header rather
 * than the value itself.
 *
 * Big-endian ("MM") throughout. That is itself a structural signature — most
 * phone cameras write little-endian — which the linter reports rather than
 * hides.
 */

const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

const TAG = {
  MAKE: 0x010f,
  MODEL: 0x0110,
  SOFTWARE: 0x0131,
  DATETIME: 0x0132,
  ARTIST: 0x013b,
  EXIF_IFD: 0x8769,
  GPS_IFD: 0x8825,
  DATETIME_ORIGINAL: 0x9003,
  CREATE_DATE: 0x9004,
  OFFSET_TIME: 0x9011,
  GPS_LAT_REF: 0x0001,
  GPS_LAT: 0x0002,
  GPS_LON_REF: 0x0003,
  GPS_LON: 0x0004,
} as const;

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Raw value bytes. Four or fewer are stored inline in the entry. */
  readonly data: Uint8Array;
  /** Set when the value is a pointer resolved after layout. */
  readonly pointerTo?: "exif" | "gps";
}

const ascii = (s: string): Uint8Array => {
  const withNul = `${s}\0`;
  const out = new Uint8Array(withNul.length);
  for (let i = 0; i < withNul.length; i++) out[i] = withNul.charCodeAt(i) & 0xff;
  return out;
};

const u32be = (v: number): Uint8Array =>
  new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

/** Three RATIONALs: degrees, minutes, seconds — seconds at 1/10000 precision. */
function dms(value: number): Uint8Array {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60 * 10000);
  const out = new Uint8Array(24);
  out.set(u32be(deg), 0);
  out.set(u32be(1), 4);
  out.set(u32be(min), 8);
  out.set(u32be(1), 12);
  out.set(u32be(sec), 16);
  out.set(u32be(10000), 20);
  return out;
}

const asciiEntry = (tag: number, value: string): Entry => {
  const data = ascii(value);
  return { tag, type: TYPE_ASCII, count: data.length, data };
};

/** EXIF wants "YYYY:MM:DD HH:MM:SS". Accepts that, or anything Date parses. */
export function exifDateTime(input: string): string {
  if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(input)) return input;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function ifd0Entries(p: SpoofProfile, hasExif: boolean, hasGps: boolean): Entry[] {
  const out: Entry[] = [];
  if (p.make) out.push(asciiEntry(TAG.MAKE, p.make));
  if (p.model) out.push(asciiEntry(TAG.MODEL, p.model));
  if (p.software) out.push(asciiEntry(TAG.SOFTWARE, p.software));
  if (p.dateTime) out.push(asciiEntry(TAG.DATETIME, exifDateTime(p.dateTime)));
  if (p.artist) out.push(asciiEntry(TAG.ARTIST, p.artist));
  if (hasExif) {
    out.push({ tag: TAG.EXIF_IFD, type: TYPE_LONG, count: 1, data: u32be(0), pointerTo: "exif" });
  }
  if (hasGps) {
    out.push({ tag: TAG.GPS_IFD, type: TYPE_LONG, count: 1, data: u32be(0), pointerTo: "gps" });
  }
  return out.sort((a, b) => a.tag - b.tag);
}

function exifEntries(p: SpoofProfile): Entry[] {
  const out: Entry[] = [];
  if (p.dateTime) {
    const dt = exifDateTime(p.dateTime);
    out.push(asciiEntry(TAG.DATETIME_ORIGINAL, dt));
    out.push(asciiEntry(TAG.CREATE_DATE, dt));
  }
  if (p.offsetTime) out.push(asciiEntry(TAG.OFFSET_TIME, p.offsetTime));
  return out.sort((a, b) => a.tag - b.tag);
}

function gpsEntries(p: SpoofProfile): Entry[] {
  if (typeof p.latitude !== "number" || typeof p.longitude !== "number") return [];
  return [
    asciiEntry(TAG.GPS_LAT_REF, p.latitude >= 0 ? "N" : "S"),
    { tag: TAG.GPS_LAT, type: TYPE_RATIONAL, count: 3, data: dms(p.latitude) },
    asciiEntry(TAG.GPS_LON_REF, p.longitude >= 0 ? "E" : "W"),
    { tag: TAG.GPS_LON, type: TYPE_RATIONAL, count: 3, data: dms(p.longitude) },
  ].sort((a, b) => a.tag - b.tag);
}

const blockSize = (n: number): number => 2 + n * 12 + 4;

/** Builds the TIFF block: header, IFD0, optional ExifIFD and GPS IFD, data area. */
export function buildTiff(profile: SpoofProfile): Uint8Array {
  const exif = exifEntries(profile);
  const gps = gpsEntries(profile);
  const ifd0 = ifd0Entries(profile, exif.length > 0, gps.length > 0);

  const ifd0At = 8;
  const exifAt = ifd0At + blockSize(ifd0.length);
  const gpsAt = exifAt + (exif.length ? blockSize(exif.length) : 0);
  let dataAt = gpsAt + (gps.length ? blockSize(gps.length) : 0);

  // Assign a data-area offset to every value too large to sit inline.
  const offsets = new Map<Entry, number>();
  for (const list of [ifd0, exif, gps]) {
    for (const e of list) {
      if (e.data.length > 4) {
        offsets.set(e, dataAt);
        dataAt += e.data.length + (e.data.length % 2); // keep word alignment
      }
    }
  }

  const total = dataAt;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  buf[0] = 0x4d;
  buf[1] = 0x4d; // "MM"
  view.setUint16(2, 0x002a);
  view.setUint32(4, ifd0At);

  const writeBlock = (entries: Entry[], at: number, next: number) => {
    view.setUint16(at, entries.length);
    let p = at + 2;
    for (const e of entries) {
      view.setUint16(p, e.tag);
      view.setUint16(p + 2, e.type);
      view.setUint32(p + 4, e.count);
      if (e.pointerTo) {
        view.setUint32(p + 8, e.pointerTo === "exif" ? exifAt : gpsAt);
      } else if (e.data.length > 4) {
        const off = offsets.get(e)!;
        view.setUint32(p + 8, off);
        buf.set(e.data, off);
      } else {
        buf.set(e.data, p + 8); // inline, left-aligned, zero-padded
      }
      p += 12;
    }
    view.setUint32(p, next);
  };

  writeBlock(ifd0, ifd0At, 0);
  if (exif.length) writeBlock(exif, exifAt, 0);
  if (gps.length) writeBlock(gps, gpsAt, 0);

  return buf;
}

/** Wraps the TIFF block in a complete APP1 segment, ready to splice. */
export function buildExifApp1(profile: SpoofProfile): Uint8Array {
  const tiff = buildTiff(profile);
  const header = ascii("Exif").subarray(0, 5); // "Exif\0"
  const length = 2 + 6 + tiff.length;
  if (length > 0xffff) throw new Error("EXIF block exceeds the 64 KB APP1 limit");

  const out = new Uint8Array(4 + 6 + tiff.length);
  out[0] = 0xff;
  out[1] = 0xe1;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(header, 4);
  out[9] = 0x00; // second NUL of "Exif\0\0"
  out.set(tiff, 10);
  return out;
}
