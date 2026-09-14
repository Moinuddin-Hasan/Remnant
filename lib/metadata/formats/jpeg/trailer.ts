import { asciiBytes, type Reader } from "../../reader";
import type { ByteRange, EmbeddedAsset } from "../../types";

/**
 * Everything after the end-of-image marker.
 *
 * A JPEG is finished at FFD9. Anything past it is payload a viewer will never
 * decode and most tools will never look at. Samsung's Motion Photo appends a
 * complete MP4 of the seconds around the shot — audio included — so a "photo"
 * you share can carry a short video of the room you were standing in.
 */

const SIG_FTYP = asciiBytes("ftyp");
const SIG_MOTION = asciiBytes("MotionPhoto_Data");
const SIG_ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const SIG_JPEG = new Uint8Array([0xff, 0xd8, 0xff]);

export interface TrailerInfo {
  readonly asset: EmbeddedAsset;
  readonly kindLabel: string;
}

export async function inspectTrailer(
  src: Reader,
  trailer: ByteRange,
): Promise<TrailerInfo | null> {
  const length = trailer.end - trailer.start;
  if (length < 8) return null;

  const kb = Math.round(length / 1024);
  const head = await src.bytes({
    start: trailer.start,
    end: Math.min(trailer.end, trailer.start + 4096),
  });

  const startsWith = (sig: Uint8Array, at = 0): boolean => {
    for (let i = 0; i < sig.length; i++) if (head[at + i] !== sig[i]) return false;
    return true;
  };

  // An ISOBMFF box header is `size:4 | 'ftyp'`, so the brand sits at offset 4.
  const hasFtyp = startsWith(SIG_FTYP, 4) || (await src.find(SIG_FTYP, trailer.start, 65536)) >= 0;
  const hasMotion = (await src.find(SIG_MOTION, trailer.start, length)) >= 0;

  if (hasFtyp || hasMotion) {
    return {
      kindLabel: "Motion Photo video",
      asset: {
        kind: "trailer-video",
        mime: "video/mp4",
        range: trailer,
        note:
          `A complete MP4 video (${kb} KB) is appended after the end-of-image marker. ` +
          `This is a Motion Photo: a few seconds of footage, often with audio, recorded ` +
          `around the moment the shutter fired. No image viewer will show it to you.`,
      },
    };
  }

  if (startsWith(SIG_JPEG)) {
    return {
      kindLabel: "appended JPEG",
      asset: {
        kind: "trailer-data",
        mime: "image/jpeg",
        range: trailer,
        note: `A second JPEG (${kb} KB) is appended after the end-of-image marker.`,
      },
    };
  }

  if (startsWith(SIG_ZIP)) {
    return {
      kindLabel: "appended archive",
      asset: {
        kind: "trailer-data",
        mime: "application/zip",
        range: trailer,
        note: `A ZIP archive (${kb} KB) is appended after the end-of-image marker.`,
      },
    };
  }

  return {
    kindLabel: "unidentified trailer",
    asset: {
      kind: "trailer-data",
      mime: "application/octet-stream",
      range: trailer,
      note:
        `${kb} KB of unidentified data sits after the end-of-image marker. The image is ` +
        `complete without it, so nothing renders these bytes — but they travel with the file.`,
    },
  };
}
