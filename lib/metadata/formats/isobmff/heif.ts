import type { FormatHandler } from "../../handler";
import type { Reader } from "../../reader";
import type { Finding, Report } from "../../types";
import { tiffFindings } from "../png/tiff";
import { walkRange, walkTree, type Box } from "./boxes";

/**
 * HEIC / HEIF / AVIF / Canon CR3 — read-only, by design.
 *
 * These share the ISOBMFF box grammar but store content as *items*: the image,
 * its thumbnail, its depth map, its HDR gain map and its EXIF are separate
 * entries located through `iloc`. A strip that rewrites the container without
 * an item-level rewriter leaves the originals sitting in `mdat`. So this
 * handler ships `inspect` alone — Tier 3 — and says so.
 */

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis", "crx "]);
const VIDEO_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "qt  ", "M4V ", "M4A ", "3gp4", "3gp5", "3gp6", "dash"]);
const EXIF_CAP = 32 << 20;

/** The HEIF-family brand of an `ftyp`-led file, or null for ordinary MP4/MOV. */
export function heifBrand(head: Uint8Array): string | null {
  const s = (a: number) => String.fromCharCode(...head.subarray(a, a + 4));
  if (s(4) !== "ftyp") return null;
  const major = s(8);
  if (HEIF_BRANDS.has(major)) return major;
  if (VIDEO_BRANDS.has(major)) return null;
  const size = ((head[0]! << 24) >>> 0) + (head[1]! << 16) + (head[2]! << 8) + head[3]!;
  for (let at = 16; at + 4 <= Math.min(size, head.length); at += 4) {
    if (HEIF_BRANDS.has(s(at))) return s(at);
  }
  return null;
}

interface Item {
  readonly type: string;
  readonly contentType: string;
}

async function cstring(src: Reader, at: number, end: number): Promise<{ value: string; next: number }> {
  const b = await src.bytes({ start: at, end: Math.min(end, at + 256) });
  const nul = b.indexOf(0);
  const len = nul < 0 ? b.length : nul;
  return { value: new TextDecoder().decode(b.subarray(0, len)), next: at + len + 1 };
}

async function items(src: Reader, iinf: Box): Promise<Item[]> {
  const v0 = (await src.u8(iinf.bodyStart)) === 0;
  const first = iinf.bodyStart + 4 + (v0 ? 2 : 4);
  const infes = await walkRange(src, first, iinf.end, "iinf", "meta/iinf", 3, []);
  const out: Item[] = [];
  for (const e of infes) {
    if (e.type !== "infe") continue;
    const version = await src.u8(e.bodyStart);
    if (version < 2) {
      out.push({ type: "mime", contentType: "" });
      continue;
    }
    const at = e.bodyStart + 4 + (version === 2 ? 2 : 4) + 2; // item_ID, protection index
    const type = await src.ascii({ start: at, end: at + 4 });
    let contentType = "";
    if (type === "mime") {
      const name = await cstring(src, at + 4, e.end);
      contentType = (await cstring(src, name.next, e.end)).value;
    }
    out.push({ type, contentType });
  }
  return out;
}

async function refCounts(src: Reader, iref: Box): Promise<Map<string, number>> {
  const refs = await walkRange(src, iref.bodyStart + 4, iref.end, "iref", "meta/iref", 3, []);
  const counts = new Map<string, number>();
  for (const r of refs) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  return counts;
}

const LABELS: Record<string, string> = { crx: "Canon CR3 raw", avif: "AVIF image", avis: "AVIF image sequence" };

async function inspect(src: Reader): Promise<Report> {
  const tree = await walkTree(src);
  const head = await src.bytes({ start: 0, end: Math.min(src.size, 4096) });
  const brand = (heifBrand(head) ?? "heic").trim();
  const findings: Finding[] = [];
  const unhandled: string[] = [...tree.problems];

  const meta = tree.boxes.find((b) => b.type === "meta");
  const iinf = meta?.children.find((c) => c.type === "iinf");
  const iref = meta?.children.find((c) => c.type === "iref");
  const list = iinf ? await items(src, iinf) : [];
  const refs = iref ? await refCounts(src, iref) : new Map<string, number>();

  const images = list.filter((i) => ["hvc1", "av01", "jpeg", "grid", "iden", "iovl", "tmap"].includes(i.type)).length;
  if (list.length) {
    findings.push({
      id: "heif.items",
      label: "Item structure",
      value: `${list.length} item${list.length > 1 ? "s" : ""}, ${images} of them image data`,
      group: "software",
      severity: "benign",
    });
  }
  if (list.some((i) => i.type === "Exif")) {
    findings.push({ id: "heif.exif", label: "EXIF item", value: "stored as a separate item", group: "history", severity: "notable" });
    findings.push(...(await tiffFindings(await src.bytes({ start: 0, end: Math.min(src.size, EXIF_CAP) }))));
  }
  if (list.some((i) => i.type === "mime" && i.contentType.includes("rdf+xml"))) {
    findings.push({ id: "heif.xmp", label: "XMP item", value: "stored as a separate item", group: "history", severity: "notable" });
  }
  const thumbs = refs.get("thmb") ?? 0;
  if (thumbs) {
    findings.push({
      id: "heif.thmb",
      label: "Thumbnail image item",
      value: `${thumbs} thumbnail reference${thumbs > 1 ? "s" : ""} — may still show the frame before a crop`,
      group: "remnant",
      severity: "notable",
    });
  }
  const aux = refs.get("auxl") ?? 0;
  if (aux) {
    findings.push({
      id: "heif.aux",
      label: "Auxiliary image item",
      value: `${aux} auxiliary image${aux > 1 ? "s" : ""} — depth map, alpha or HDR gain map`,
      group: "remnant",
      severity: "notable",
    });
  }
  const uuids = tree.boxes.filter((b) => b.type === "uuid").length;
  if (uuids) {
    findings.push({ id: "heif.uuid", label: "Vendor uuid boxes", value: `${uuids}`, group: "history", severity: "notable" });
  }

  unhandled.push(
    "Read-only. HEIF stores thumbnails, depth maps, HDR gain maps and EXIF as separate items " +
      "inside the media data. Removing them safely needs an item-level rewriter we do not ship, and " +
      "a naive strip leaves the originals in place — so nothing was removed and no Clean is offered.",
  );

  return {
    format: "isobmff",
    formatLabel: LABELS[brand] ?? "HEIF image",
    tier: 3,
    size: src.size,
    findings,
    assets: [],
    unhandled,
  };
}

export const heifHandler: FormatHandler = {
  id: "isobmff",
  label: "HEIF / AVIF image",
  sniff: (head) => heifBrand(head) !== null,
  inspect,
};
