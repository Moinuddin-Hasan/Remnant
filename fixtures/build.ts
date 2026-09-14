/**
 * Builds the demo/test fixture: a real, decodable JPEG that carries every
 * remnant class the tool claims to find.
 *
 * This exists because the demo depends on a file whose hidden payload differs
 * from the rendered image, and such a file cannot be assumed to be lying
 * around. Manufacturing it deliberately — and asserting against it in tests —
 * is what stops the pitch from resting on a photo we hope behaves.
 */

/** A real 16x16 JPEG produced by PIL at quality 80. Decodable, tiny, no metadata. */
const BASE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcU" +
  "FhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgo" +
  "KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIA" +
  "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA" +
  "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3" +
  "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm" +
  "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA" +
  "AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx" +
  "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK" +
  "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3" +
  "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyrSfD" +
  "v3fk/Suz0nw70+T9K7HSfDv3fk/Suz0nw7935P0rXHZ5vqLhXiP4dT//2Q==";

export function baseJpeg(): Uint8Array {
  const bin = typeof atob === "function"
    ? atob(BASE_JPEG_B64)
    : Buffer.from(BASE_JPEG_B64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class Writer {
  private buf: number[] = [];
  get length(): number {
    return this.buf.length;
  }
  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v >> 8).u8(v);
  }
  u32(v: number): this {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  raw(b: Uint8Array): this {
    for (const v of b) this.u8(v);
    return this;
  }
  at(i: number, v: number): this {
    this.buf[i] = v & 0xff;
    return this;
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_UNDEFINED = 7;

export const FIXTURE_LAT = 12.9716;
export const FIXTURE_LON = 79.1588;
export const FIXTURE_MAKE = "Remnant Test";
export const FIXTURE_MODEL = "Fixture Cam 1";

/**
 * APP1 / Exif with Make, Model and a GPS IFD.
 * All offsets are relative to the TIFF header, per TIFF 6.0.
 */
function buildExifSegment(): Uint8Array {
  const make = `${FIXTURE_MAKE}\0`;
  const model = `${FIXTURE_MODEL}\0`;

  const IFD0 = 8;
  const entries0 = 3;
  const dataStart = IFD0 + 2 + entries0 * 12 + 4;

  const makeAt = dataStart;
  const modelAt = makeAt + make.length;
  const gpsIfdAt = modelAt + model.length;

  const gpsEntries = 4;
  const gpsDataAt = gpsIfdAt + 2 + gpsEntries * 12 + 4;
  const latAt = gpsDataAt;
  const lonAt = latAt + 24;

  const t = new Writer();
  t.ascii("MM").u16(0x002a).u32(IFD0);

  t.u16(entries0);
  t.u16(0x010f).u16(TYPE_ASCII).u32(make.length).u32(makeAt);
  t.u16(0x0110).u16(TYPE_ASCII).u32(model.length).u32(modelAt);
  t.u16(0x8825).u16(TYPE_LONG).u32(1).u32(gpsIfdAt);
  t.u32(0);

  t.ascii(make).ascii(model);

  // GPS IFD
  t.u16(gpsEntries);
  t.u16(0x0001).u16(TYPE_ASCII).u32(2).ascii("N\0").u16(0); // ref fits inline
  t.u16(0x0002).u16(TYPE_RATIONAL).u32(3).u32(latAt);
  t.u16(0x0003).u16(TYPE_ASCII).u32(2).ascii("E\0").u16(0);
  t.u16(0x0004).u16(TYPE_RATIONAL).u32(3).u32(lonAt);
  t.u32(0);

  // 12.9716° → 12° 58' 17.76"   79.1588° → 79° 9' 31.68"
  t.u32(12).u32(1).u32(58).u32(1).u32(1776).u32(100);
  t.u32(79).u32(1).u32(9).u32(1).u32(3168).u32(100);

  const tiff = t.bytes();
  const seg = new Writer();
  seg.u16(0xffe1).u16(2 + 6 + tiff.length).ascii("Exif\0\0").raw(tiff);
  return seg.bytes();
}

/** APP2 / MPF declaring two images: the primary, and one hidden second image. */
function buildMpfSegment(primarySize: number, secondSize: number, secondOffset: number): Uint8Array {
  const IFD = 8;
  const entries = 3;
  const entryDataAt = IFD + 2 + entries * 12 + 4;

  const t = new Writer();
  t.ascii("MM").u16(0x002a).u32(IFD);
  t.u16(entries);
  t.u16(0xb000).u16(TYPE_UNDEFINED).u32(4).ascii("0100");
  t.u16(0xb001).u16(TYPE_LONG).u32(1).u32(2);
  t.u16(0xb002).u16(TYPE_UNDEFINED).u32(32).u32(entryDataAt);
  t.u32(0);
  // MPEntry 0: the primary image, offset defined as 0
  t.u32(0x0003_0000).u32(primarySize).u32(0).u16(0).u16(0);
  // MPEntry 1: the hidden one
  t.u32(0x0000_0000).u32(secondSize).u32(secondOffset).u16(0).u16(0);

  const tiff = t.bytes();
  const seg = new Writer();
  seg.u16(0xffe2).u16(2 + 4 + tiff.length).ascii("MPF\0").raw(tiff);
  return seg.bytes();
}

/** A minimal ISOBMFF `ftyp` box plus a Samsung-style marker, standing in for a Motion Photo. */
function buildTrailer(): Uint8Array {
  const w = new Writer();
  w.u32(20).ascii("ftyp").ascii("mp42").u32(0).ascii("mp42");
  w.ascii("MotionPhoto_Data");
  for (let i = 0; i < 256; i++) w.u8((i * 7) & 0xff);
  return w.bytes();
}

export interface Fixture {
  readonly bytes: Uint8Array;
  readonly secondImageRange: { start: number; end: number };
  readonly trailerStart: number;
}

/**
 * Layout:
 *   SOI | APP1(Exif+GPS) | APP2(MPF) | <base image body … EOI> | <second image> | <trailer>
 */
export function buildFixtureJpeg(): Fixture {
  const base = baseJpeg();
  const body = base.subarray(2); // everything after SOI, through EOI
  const second = base; // a complete JPEG standing in as the hidden second capture

  const app1 = buildExifSegment();

  // The MPF segment's length does not depend on the offset values, so build it
  // once to measure, then rebuild with the real offset.
  const probe = buildMpfSegment(body.length, second.length, 0);
  const app2Start = 2 + app1.length;
  const mpfTiffBase = app2Start + 4 + 4; // marker+len, then "MPF\0"
  const bodyStart = app2Start + probe.length;
  const secondStart = bodyStart + body.length;
  const app2 = buildMpfSegment(body.length, second.length, secondStart - mpfTiffBase);

  const out = new Writer();
  out.u16(0xffd8).raw(app1).raw(app2).raw(body).raw(second).raw(buildTrailer());

  return {
    bytes: out.bytes(),
    secondImageRange: { start: secondStart, end: secondStart + second.length },
    trailerStart: secondStart + second.length,
  };
}
