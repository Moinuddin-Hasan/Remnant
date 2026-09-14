import type { FormatHandler } from "../../handler";
import type { Reader } from "../../reader";
import type { Finding, Report } from "../../types";
import { scanStrings, type HitKind } from "../../scan/strings";

const GROUP: Record<HitKind, Finding["group"]> = {
  path: "identity",
  email: "identity",
  url: "history",
  host: "identity",
  guid: "device",
};

const SEVERITY: Record<HitKind, Finding["severity"]> = {
  path: "critical",
  email: "critical",
  url: "notable",
  host: "critical",
  guid: "notable",
};

const LABEL: Record<HitKind, string> = {
  path: "Absolute path",
  email: "Email address",
  url: "URL",
  host: "Hostname",
  guid: "GUID",
};

/**
 * Last handler in the registry. Always matches, and deliberately ships no
 * `plan`, which makes it Tier 3 — the UI cannot offer a Clean button for it.
 *
 * This is the honest half of the product. We cannot write a parser for every
 * format, so for everything else we report what we found and refuse to say the
 * file is clean. mat2 takes the same stance in its own documentation; a tool
 * that shows an empty panel on a file it only partially understood is worse
 * than no tool, because the user then shares it.
 */
async function inspect(src: Reader): Promise<Report> {
  const hits = await scanStrings(src);

  const findings: Finding[] = hits.map((h, i) => ({
    id: `scan.${h.kind}.${i}`,
    label: LABEL[h.kind],
    value: h.value,
    group: GROUP[h.kind],
    severity: SEVERITY[h.kind],
    range: { start: h.offset, end: h.offset + h.value.length },
  }));

  return {
    format: "unknown",
    formatLabel: "Unrecognised binary",
    tier: 3,
    size: src.size,
    findings,
    assets: [],
    unhandled: [
      "This format has no parser here. The findings above come from a raw byte scan of the " +
        "whole file in both latin1 and UTF-16LE.",
      "Nothing was removed and nothing can be: we will not rewrite a container we do not " +
        "understand, because a broken file is worse than a leaky one.",
      "A scan finding nothing is not evidence the file is clean. It is evidence this scan " +
        "found nothing.",
    ],
  };
}

export const unknownHandler: FormatHandler = {
  id: "unknown",
  label: "Unrecognised binary",
  sniff: () => true,
  inspect,
};
