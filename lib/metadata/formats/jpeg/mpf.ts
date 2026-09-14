import type { Reader } from "../../reader";
import type { EmbeddedAsset } from "../../types";
import type { Segment } from "./segments";

/**
 * APP2 / Multi-Picture Format.
 *
 * This is the least-known high-value leak in a phone photo. Samsung and Apple
 * devices routinely embed a *second full-resolution image* here — the other
 * lens's frame, the HDR companion, or the depth capture. It survives every
 * tool that strips "EXIF" by removing APP1, and nothing in a normal viewer
 * ever renders it, so the user has no idea it is there.
 *
 * Layout: the APP2 payload starts with "MPF\0", then a TIFF header. Every
 * offset in the MP Index IFD is relative to the start of that TIFF header,
 * except the primary image whose offset is defined as 0.
 */

const TAG_NUMBER_OF_IMAGES = 0xb001;
const TAG_MP_ENTRY = 0xb002;
const MP_ENTRY_SIZE = 16;

interface Tiff {
  readonly base: number;
  readonly little: boolean;
  readonly ifd0: number;
}

async function readTiffHeader(src: Reader, base: number): Promise<Tiff | null> {
  const order = await src.u16be(base);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return null;
  const magic = little ? await src.u16le(base + 2) : await src.u16be(base + 2);
  if (magic !== 0x2a) return null;
  const ifd0 = little ? await src.u32le(base + 4) : await src.u32be(base + 4);
  return { base, little, ifd0 };
}

export async function parseMpf(
  src: Reader,
  seg: Segment,
): Promise<{ assets: EmbeddedAsset[]; imageCount: number }> {
  const none = { assets: [] as EmbeddedAsset[], imageCount: 0 };

  // payload: "MPF\0" then the TIFF header
  const tag = await src.ascii({ start: seg.dataStart, end: seg.dataStart + 4 });
  if (!tag.startsWith("MPF")) return none;

  const base = seg.dataStart + 4;
  const tiff = await readTiffHeader(src, base);
  if (!tiff) return none;

  const u16 = (at: number) => (tiff.little ? src.u16le(at) : src.u16be(at));
  const u32 = (at: number) => (tiff.little ? src.u32le(at) : src.u32be(at));

  const ifd = base + tiff.ifd0;
  if (ifd + 2 > seg.end) return none;

  const count = await u16(ifd);
  if (count === 0 || count > 64) return none;

  let numberOfImages = 0;
  let entriesAt = -1;
  let entriesLen = 0;

  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > seg.end) break;
    const tagId = await u16(e);
    const valueCount = await u32(e + 4);
    const value = await u32(e + 8);
    if (tagId === TAG_NUMBER_OF_IMAGES) {
      numberOfImages = value;
    } else if (tagId === TAG_MP_ENTRY) {
      entriesAt = base + value;
      entriesLen = valueCount;
    }
  }

  if (entriesAt < 0 || entriesLen < MP_ENTRY_SIZE) return { assets: [], imageCount: numberOfImages };

  const total = Math.min(Math.floor(entriesLen / MP_ENTRY_SIZE), numberOfImages || 8);
  const assets: EmbeddedAsset[] = [];

  for (let i = 0; i < total; i++) {
    const e = entriesAt + i * MP_ENTRY_SIZE;
    if (e + MP_ENTRY_SIZE > src.size) break;
    const size = await u32(e + 4);
    const offset = await u32(e + 8);
    // offset 0 is the primary image — the one the viewer already shows.
    if (offset === 0 || size === 0) continue;
    const start = base + offset;
    const end = start + size;
    if (start < 0 || end > src.size || end <= start) continue;
    assets.push({
      kind: "second-image",
      mime: "image/jpeg",
      range: { start, end },
      note:
        `A second full-resolution image (${Math.round(size / 1024)} KB) is embedded in this ` +
        `file via APP2 MPF. Your viewer never shows it, and stripping EXIF alone leaves it intact.`,
    });
  }

  return { assets, imageCount: numberOfImages || assets.length + 1 };
}
