import type { FormatHandler } from "../../handler";
import { planOf, replace, type Edit, type Patch } from "../../patch";
import type { Reader } from "../../reader";
import type { EmbeddedAsset, Finding, Report } from "../../types";
import { flatten, freeBox, headerTimes, macTime, walkTree, type Box } from "./boxes";
import { heifBrand } from "./heif";
import { metaFindings, udtaChildFindings, uuidFindings } from "./meta";

/**
 * MP4 / MOV / M4V / 3GP.
 *
 * Nothing is ever deleted. Removing a byte before `mdat` shifts every chunk
 * offset in `stco`/`co64`, and the failure mode of getting that wrong is a file
 * that plays in Chrome and fails in QuickTime. Instead each metadata box is
 * overwritten in place by a `free` box of exactly the same length, and the
 * header timestamps are zeroed in place. Zero size delta, no remux, no offset
 * touched, constant time on a file of any size.
 */

const TIME_BOXES = new Set(["mvhd", "tkhd", "mdhd"]);
const NEUTRALISE = new Set(["udta", "meta", "uuid"]);
/** Track handlers whose samples are metadata, not media: per-frame GPS, gyro, and so on. */
const TIMED_METADATA = new Set(["meta", "camm"]);

const BRAND_LABELS: Record<string, string> = {
  "qt  ": "QuickTime movie",
  "M4A ": "MPEG-4 audio",
  "M4V ": "MPEG-4 video",
  "3gp4": "3GPP video",
  "3gp5": "3GPP video",
  "3gp6": "3GPP video",
};

async function formatLabel(src: Reader, boxes: readonly Box[]): Promise<string> {
  const ftyp = boxes[0]?.type === "ftyp" ? boxes[0] : undefined;
  if (!ftyp) return "QuickTime movie";
  const brand = await src.ascii({ start: ftyp.bodyStart, end: ftyp.bodyStart + 4 });
  return BRAND_LABELS[brand] ?? "MP4 video";
}

async function timeFindings(src: Reader, flat: readonly Box[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  let trackHeaders = 0;
  let earliest: Date | null = null;
  for (const b of flat) {
    if (!TIME_BOXES.has(b.type)) continue;
    const t = await headerTimes(src, b);
    if (!t) continue;
    const created = macTime(t.created);
    const modified = macTime(t.modified);
    if (!created && !modified) continue;
    if (b.type === "mvhd") {
      const value = [created && `created ${created.toISOString()}`, modified && `modified ${modified.toISOString()}`]
        .filter(Boolean)
        .join(", ");
      findings.push({
        id: `mp4.time.${b.start}`,
        label: "Recording time (movie header)",
        value,
        group: "time",
        severity: "notable",
        range: t.range,
      });
    } else {
      trackHeaders++;
      const d = created ?? modified!;
      if (!earliest || d < earliest) earliest = d;
    }
  }
  if (trackHeaders > 0) {
    findings.push({
      id: "mp4.time.tracks",
      label: "Timestamps in track and media headers",
      value: `${trackHeaders} header${trackHeaders > 1 ? "s" : ""}, earliest ${earliest!.toISOString()}`,
      group: "time",
      severity: "notable",
    });
  }
  return findings;
}

async function trackHandler(src: Reader, trak: Box): Promise<string | null> {
  const hdlr = trak.children.find((c) => c.type === "mdia")?.children.find((c) => c.type === "hdlr");
  if (!hdlr || hdlr.bodyStart + 12 > hdlr.end) return null;
  return src.ascii({ start: hdlr.bodyStart + 8, end: hdlr.bodyStart + 12 });
}

const container = (b: Box, label: string): Finding => ({
  id: `mp4.${b.type}.${b.start}`,
  label,
  value: `${(b.end - b.start).toLocaleString()} bytes at offset ${b.start.toLocaleString()}`,
  group: "history",
  severity: "notable",
  range: { start: b.start, end: b.end },
});

async function inspect(src: Reader): Promise<Report> {
  const tree = await walkTree(src);
  const flat = flatten(tree.boxes);
  const findings: Finding[] = [];
  const assets: EmbeddedAsset[] = [];
  const unhandled: string[] = [...tree.problems];
  let timedTracks = 0;

  findings.push(...(await timeFindings(src, flat)));

  for (const b of flat) {
    if (b.type === "udta") {
      findings.push(container(b, "User-data box (udta)"));
      for (const child of b.children) findings.push(...(await udtaChildFindings(src, child)));
    } else if (b.type === "meta") {
      findings.push(container(b, "Metadata box (meta)"));
      const m = await metaFindings(src, b);
      findings.push(...m.findings);
      assets.push(...m.assets);
    } else if (b.type === "uuid") {
      findings.push(...(await uuidFindings(src, b)));
    } else if (b.type === "trak") {
      const handler = await trackHandler(src, b);
      if (handler && TIMED_METADATA.has(handler)) {
        timedTracks++;
        findings.push({
          id: `mp4.timed.${b.start}`,
          label: "Timed metadata track",
          value: `handler "${handler}" — per-frame data (often GPS or motion) stored as samples`,
          group: "remnant",
          severity: "critical",
          range: { start: b.start, end: b.end },
        });
      }
    }
  }

  unhandled.push(
    "Neutralised, not deleted: each metadata box is overwritten in place by a \"free\" box of the " +
      "same size with its contents zeroed. The file keeps its exact length so every sample offset " +
      "stays valid; the zeroed bytes are still there.",
  );
  if (timedTracks > 0) {
    unhandled.push(
      "Timed metadata tracks are samples inside the media data, indexed by the same tables as the " +
        "video. They are reported but not removed, so a clean of this file is partial.",
    );
  }
  unhandled.push(
    "Audio and video streams are not examined. Faces, voices and background sound are content, " +
      "and encoder settings written inside the bitstream (x264 stores its full option string in the " +
      "first frame) are not inspected. The codec's compressor name in the sample description " +
      "(for example \"Lavc61.3.100 libx264\") is kept: it names the encoder, not you.",
  );

  const seen = new Set<string>();
  const unique = findings.filter((f) => !seen.has(f.id) && (seen.add(f.id), true));

  return {
    format: "isobmff",
    formatLabel: await formatLabel(src, tree.boxes),
    tier: 2,
    size: src.size,
    findings: unique,
    assets,
    unhandled,
  };
}

async function plan(src: Reader): Promise<Edit> {
  const flat = flatten((await walkTree(src)).boxes);

  // Neutralise only the outermost target: a `meta` inside a `udta` goes with it.
  const targets = flat.filter((b) => NEUTRALISE.has(b.type));
  const outer = targets.filter(
    (b) => !targets.some((o) => o !== b && o.start <= b.start && b.end <= o.end),
  );
  const patches: Patch[] = outer.map((b) => replace({ start: b.start, end: b.end }, freeBox(b.end - b.start)));

  for (const b of flat) {
    if (!TIME_BOXES.has(b.type)) continue;
    const t = await headerTimes(src, b);
    if (t && (t.created || t.modified)) {
      patches.push(replace(t.range, new Uint8Array(t.range.end - t.range.start)));
    }
  }

  return { kind: "patch", plan: planOf(patches) };
}

const QUICKTIME_FIRST_BOX = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

export const isobmffHandler: FormatHandler = {
  id: "isobmff",
  label: "MP4 / MOV video",
  sniff: (head, filename) => {
    const t = String.fromCharCode(...head.subarray(4, 8));
    if (t === "ftyp") return heifBrand(head) === null;
    // Pre-2001 QuickTime files have no ftyp; trust the extension only then.
    return QUICKTIME_FIRST_BOX.has(t) && /\.(mov|qt|mp4|m4v|m4a|3gp)$/i.test(filename);
  },
  inspect,
  plan,
};

export { heifHandler } from "./heif";
