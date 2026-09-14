/**
 * Builds the PNG test fixture: a real, decodable 16x16 image carrying every
 * metadata chunk the PNG handler claims to read, plus an aCropalypse-style
 * leftover after IEND.
 *
 * Node-only (it uses node:zlib for IDAT/zTXt compression and chunk CRCs). The
 * handler itself never computes a CRC; the fixture has to, to be a valid file.
 */
import { crc32, deflateSync } from "node:zlib";

export const PNG_FIXTURE = {
  author: "Rayyan Azeez",
  comment: "Taken from room 412, Block C",
  software: "Fixture Painter 2.1",
  make: "Remnant Test",
  model: "Fixture Cam 1",
  xmpCreator: "Moinuddin Hasan",
  lat: 12.9716,
  lon: 79.1588,
  iccName: "Fixture ICC",
  time: "2026-09-14T10:30:00Z",
} as const;

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u32be = (v: number): Uint8Array =>
  new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat(ascii(type), data);
  return concat(u32be(data.length), body, u32be(crc32(body)));
}

/**
 * A big-endian TIFF block: IFD0 with Make and Model, and a GPS IFD.
 * Offsets are relative to the TIFF header, per TIFF 6.0. Shared with the WebP
 * and ISOBMFF fixtures.
 */
export function buildTiff(o: { make: string; model: string; lat: number; lon: number }): Uint8Array {
  const make = `${o.make}\0`;
  const model = `${o.model}\0`;
  const ifd0 = 8;
  const makeAt = ifd0 + 2 + 3 * 12 + 4;
  const modelAt = makeAt + make.length;
  const gpsAt = modelAt + model.length;
  const latAt = gpsAt + 2 + 4 * 12 + 4;
  const lonAt = latAt + 24;

  const b: number[] = [];
  const u16 = (v: number) => b.push((v >> 8) & 0xff, v & 0xff);
  const u32 = (v: number) => b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const str = (s: string) => {
    for (const c of s) b.push(c.charCodeAt(0));
  };
  const dms = (v: number) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = Math.round(((a - d) * 60 - m) * 60 * 100);
    u32(d); u32(1); u32(m); u32(1); u32(s); u32(100);
  };

  str("MM"); u16(42); u32(ifd0);
  u16(3);
  u16(0x010f); u16(2); u32(make.length); u32(makeAt);
  u16(0x0110); u16(2); u32(model.length); u32(modelAt);
  u16(0x8825); u16(4); u32(1); u32(gpsAt);
  u32(0);
  str(make); str(model);
  u16(4);
  u16(0x0001); u16(2); u32(2); str(o.lat >= 0 ? "N" : "S"); b.push(0, 0, 0);
  u16(0x0002); u16(5); u32(3); u32(latAt);
  u16(0x0003); u16(2); u32(2); str(o.lon >= 0 ? "E" : "W"); b.push(0, 0, 0);
  u16(0x0004); u16(5); u32(3); u32(lonAt);
  u32(0);
  dms(o.lat);
  dms(o.lon);
  return new Uint8Array(b);
}

export function xmpPacket(o: { creator: string; lat: number; lon: number }): string {
  const coord = (v: number, pos: string, neg: string) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    return `${d},${((a - d) * 60).toFixed(4)}${v >= 0 ? pos : neg}`;
  };
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:exif="http://ns.adobe.com/exif/1.0/" ` +
    `exif:GPSLatitude="${coord(o.lat, "N", "S")}" exif:GPSLongitude="${coord(o.lon, "E", "W")}">` +
    `<dc:creator><rdf:Seq><rdf:li>${o.creator}</rdf:li></rdf:Seq></dc:creator>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

export interface PngFixture {
  readonly bytes: Uint8Array;
  readonly idatRange: { start: number; end: number };
  readonly trailerStart: number;
}

export function buildFixturePng(): PngFixture {
  const f = PNG_FIXTURE;
  const W = 16;
  const H = 16;

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(W), 0);
  ihdr.set(u32be(H), 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, deflate, adaptive filter, no interlace

  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    for (let x = 0; x < W; x++) raw.set([x * 16, y * 16, 128], row + 1 + x * 3);
  }

  const iccp = concat(ascii(`${f.iccName}\0`), new Uint8Array([0]), deflateSync(ascii("not-a-real-profile")));
  const phys = concat(u32be(2835), u32be(2835), new Uint8Array([1]));
  const ztxt = concat(ascii("Comment\0"), new Uint8Array([0]), deflateSync(ascii(f.comment)));
  const xmp = new TextEncoder().encode(xmpPacket({ creator: f.xmpCreator, lat: f.lat, lon: f.lon }));
  const itxt = concat(ascii("XML:com.adobe.xmp\0"), new Uint8Array([0, 0, 0, 0]), xmp);
  const time = new Uint8Array([0x07, 0xea, 9, 14, 10, 30, 0]);

  const head = concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("iCCP", iccp),
    pngChunk("pHYs", phys),
    pngChunk("tEXt", ascii(`Author\0${f.author}`)),
    pngChunk("tEXt", ascii(`Software\0${f.software}`)),
    pngChunk("zTXt", ztxt),
    pngChunk("iTXt", itxt),
    pngChunk("eXIf", buildTiff({ make: f.make, model: f.model, lat: f.lat, lon: f.lon })),
    pngChunk("tIME", time),
  );
  const idat = pngChunk("IDAT", deflateSync(raw));
  const iend = pngChunk("IEND", new Uint8Array(0));

  // What aCropalypse leaves behind: the tail of the original, larger image's
  // IDAT stream and its own IEND, sitting after the new file's IEND.
  const leftover = concat(pngChunk("IDAT", deflateSync(new Uint8Array(512).fill(7))), iend);

  const bytes = concat(head, idat, iend, leftover);
  return {
    bytes,
    idatRange: { start: head.length, end: head.length + idat.length },
    trailerStart: head.length + idat.length + iend.length,
  };
}
