/**
 * ISOBMFF fixtures. The MP4, MOV and AVIF are real ffmpeg output (see
 * isobmff-samples.ts); the builders below only append or synthesise boxes
 * that shift no existing offset, plus two small synthetic files for the
 * 64-bit-size and timed-metadata-track paths.
 */
import { AVIF_B64, MOV_META_B64, MP4_META_B64 } from "./isobmff-samples";
import { concat, xmpPacket } from "./png";

export const ISO_FIXTURE = {
  make: "RemnantTest",
  model: "Fixture Cam 1",
  lat: 12.9716,
  lon: 79.1588,
  created: "2026-09-14T10:30:00.000Z",
  encoder: "Lavf61.1.100",
  xmpCreator: "Moinuddin Hasan",
} as const;

const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "base64"));
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const u16 = (v: number) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
const u32 = (v: number) => new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
const u64 = (v: number) => concat(u32(Math.floor(v / 2 ** 32)), u32(v >>> 0));

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32(8 + body.length), ascii(type), body);
}

const XMP_UUID = new Uint8Array([
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac,
]);

/** The ffmpeg MP4 with a top-level XMP uuid box appended after moov. */
export function buildFixtureMp4(): Uint8Array {
  const f = ISO_FIXTURE;
  const xmp = new TextEncoder().encode(xmpPacket({ creator: f.xmpCreator, lat: f.lat, lon: f.lon }));
  return concat(b64(MP4_META_B64), box("uuid", XMP_UUID, xmp));
}

export const fixtureMov = (): Uint8Array => b64(MOV_META_B64);
export const fixtureAvif = (): Uint8Array => b64(AVIF_B64);

const macSeconds = (iso: string) => Date.parse(iso) / 1000 + 2082844800;

/** A QuickTime string atom: len, language, text. */
const qtString = (type: string, s: string) => box(type, u16(s.length), u16(0x55c4), ascii(s));

/**
 * ftyp | mdat with a 64-bit size | moov(mvhd v1, udta(©mak)).
 * Exercises size == 1 and the 8-byte version-1 time fields.
 */
export function buildLargesizeMp4(): Uint8Array {
  const t = macSeconds(ISO_FIXTURE.created);
  const payload = ascii("mediamed");
  const mdat = concat(u32(1), ascii("mdat"), u64(16 + payload.length), payload);
  const mvhd = box("mvhd", new Uint8Array([1, 0, 0, 0]), u64(t), u64(t), u32(1000), u64(0), new Uint8Array(80));
  return concat(
    box("ftyp", ascii("isom"), u32(0), ascii("isom")),
    mdat,
    box("moov", mvhd, box("udta", qtString("©mak", ISO_FIXTURE.make))),
  );
}

/** A track whose handler is `meta`: timed metadata, which the tool reports but cannot remove. */
export function buildTimedMetaMp4(): Uint8Array {
  const hdlr = box("hdlr", new Uint8Array(4), u32(0), ascii("meta"), new Uint8Array(12), new Uint8Array([0]));
  return concat(
    box("ftyp", ascii("isom"), u32(0), ascii("isom")),
    box("moov", box("trak", box("mdia", hdlr))),
  );
}
