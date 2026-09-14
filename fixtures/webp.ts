/**
 * Builds the WebP test fixture: a real 16x16 lossy WebP (encoded by libwebp via
 * PIL) rewrapped in the extended format with ICCP, EXIF and XMP chunks, then
 * 64 bytes appended after the declared RIFF end.
 *
 * ICCP is deliberately odd-length so the pad-byte handling is exercised.
 */
import { buildTiff, concat, xmpPacket } from "./png";

/** 16x16 lossy WebP, simple format (RIFF/WEBP/VP8 ), no metadata. */
const BASE_WEBP_B64 =
  "UklGRlgAAABXRUJQVlA4IEwAAADQAQCdASoQABAAAUAmJbACdAEOtYnVAAD+/fBjaF/0YQhUXH7IVFgF" +
  "KkNmX/yYreLh+qPdmVmxwQTjoL//q9M9V//9afnqbi/BgAAA";

export const WEBP_FIXTURE = {
  make: "Remnant Test",
  model: "Fixture Cam 1",
  xmpCreator: "Moinuddin Hasan",
  lat: 12.9716,
  lon: 79.1588,
} as const;

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const u32le = (v: number): Uint8Array =>
  new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
const u24le = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff]);

export function baseWebp(): Uint8Array {
  return Uint8Array.from(Buffer.from(BASE_WEBP_B64, "base64"));
}

export function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1 ? new Uint8Array([0]) : new Uint8Array(0);
  return concat(ascii(fourcc), u32le(data.length), data, pad);
}

export const riffFile = (...chunks: Uint8Array[]): Uint8Array => {
  const body = concat(ascii("WEBP"), ...chunks);
  return concat(ascii("RIFF"), u32le(body.length), body);
};

export interface WebpFixture {
  readonly bytes: Uint8Array;
  /** The VP8 image chunk, which must come out of a strip byte-identical. */
  readonly vp8: Uint8Array;
  readonly trailerStart: number;
}

export function buildFixtureWebp(): WebpFixture {
  const f = WEBP_FIXTURE;
  const vp8 = baseWebp().subarray(12); // the whole "VP8 " chunk, header included

  const vp8x = concat(new Uint8Array([0x20 | 0x08 | 0x04, 0, 0, 0]), u24le(15), u24le(15));
  const icc = ascii("odd-length fake icc"); // 19 bytes → one pad byte
  const exif = buildTiff({ make: f.make, model: f.model, lat: f.lat, lon: f.lon });
  const xmp = new TextEncoder().encode(xmpPacket({ creator: f.xmpCreator, lat: f.lat, lon: f.lon }));

  const file = riffFile(
    riffChunk("VP8X", vp8x),
    riffChunk("ICCP", icc),
    vp8,
    riffChunk("EXIF", exif),
    riffChunk("XMP ", xmp),
  );
  const trailer = ascii("left behind after the container ".repeat(2));

  return { bytes: concat(file, trailer), vp8: vp8.slice(), trailerStart: file.length };
}
