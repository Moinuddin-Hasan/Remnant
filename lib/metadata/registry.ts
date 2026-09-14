import type { FormatHandler } from "./handler";
import { jpegHandler } from "./formats/jpeg";
import { pngHandler } from "./formats/png";
import { webpHandler } from "./formats/webp";
import { heifHandler, isobmffHandler } from "./formats/isobmff";
import { unknownHandler } from "./formats/unknown";

/**
 * Order matters: first match wins, and `unknownHandler` always matches, so it
 * must stay last. Adding a format is two edits — a directory under `formats/`
 * and one line here. Nothing else in the system names a format.
 */
export const HANDLERS: readonly FormatHandler[] = [
  jpegHandler,
  pngHandler,
  webpHandler,
  heifHandler, // before isobmff: HEIF shares the box grammar but is read-only
  isobmffHandler,
  unknownHandler,
];

export const SNIFF_BYTES = 4096;

export function resolve(head: Uint8Array, filename: string): FormatHandler {
  for (const h of HANDLERS) {
    try {
      if (h.sniff(head, filename)) return h;
    } catch {
      // A throwing sniff must never take down the pipeline.
    }
  }
  return unknownHandler;
}
