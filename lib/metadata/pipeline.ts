import { assemble, type Edit } from "./patch";
import { readerOf } from "./reader";
import { resolve, SNIFF_BYTES } from "./registry";
import { tierOf, type FormatHandler, type SpoofProfile } from "./handler";
import { lint, type LintResult } from "../forge/lint";
import {
  DEFAULT_STRIP,
  type Report,
  type StripOptions,
  type VerifyResult,
} from "./types";

export interface InspectResult {
  readonly report: Report;
  readonly handlerId: string;
  readonly canClean: boolean;
}

async function handlerFor(file: Blob, filename: string): Promise<FormatHandler> {
  const head = new Uint8Array(
    await file.slice(0, Math.min(file.size, SNIFF_BYTES)).arrayBuffer(),
  );
  return resolve(head, filename);
}

export async function inspectFile(file: Blob, filename: string): Promise<InspectResult> {
  const handler = await handlerFor(file, filename);
  const report = await handler.inspect(readerOf(file));
  return {
    report: { ...report, tier: tierOf(handler) },
    handlerId: handler.id,
    canClean: Boolean(handler.plan),
  };
}

export interface CleanResult {
  readonly output: Blob;
  readonly verify: VerifyResult;
  readonly rebuilt: boolean;
  readonly rebuildReason?: string;
}

/**
 * Literals from the original that must not appear anywhere in the output.
 *
 * Re-parsing the output is necessary but not sufficient: a parser only looks
 * where it knows to look. Grepping the produced bytes for the actual secrets
 * we found catches the case where data survived somewhere the parser does not
 * inspect.
 */
function sensitiveLiterals(report: Report): string[] {
  const out = new Set<string>();
  for (const f of report.findings) {
    if (f.severity === "benign") continue;
    const v = f.value.trim();
    // Byte-count strings like "812 bytes at offset 20" are not secrets.
    if (!v || v.length < 4 || /^[\d,]+ bytes/.test(v)) continue;
    if (f.group === "location") {
      for (const part of v.split(",")) {
        const t = part.trim();
        if (t.length >= 6) out.add(t);
      }
      continue;
    }
    out.add(v);
  }
  return [...out];
}

async function findLiterals(blob: Blob, literals: readonly string[]): Promise<string[]> {
  if (literals.length === 0) return [];
  const src = readerOf(blob);
  const found: string[] = [];
  for (const lit of literals) {
    const needle = new Uint8Array(lit.length);
    for (let i = 0; i < lit.length; i++) needle[i] = lit.charCodeAt(i) & 0xff;
    if ((await src.find(needle)) >= 0) found.push(lit);
  }
  return found;
}

/**
 * Strip, then re-read what we produced with the same engine that read the
 * original. The UI is not permitted to print "clean" off the back of a write —
 * only off the back of this.
 */
export async function cleanFile(
  file: Blob,
  filename: string,
  opts: StripOptions = DEFAULT_STRIP,
): Promise<CleanResult> {
  const handler = await handlerFor(file, filename);
  if (!handler.plan) {
    throw new Error(`${handler.label} is read-only here — there is no strip path for it.`);
  }

  const src = readerOf(file);
  const before = await handler.inspect(src);
  const edit: Edit = await handler.plan(src, before, opts);

  let output: Blob;
  let rebuilt = false;
  let rebuildReason: string | undefined;

  if (edit.kind === "patch") {
    output = assemble(file, edit.plan, file.type);
  } else {
    output = await edit.build();
    rebuilt = true;
    rebuildReason = edit.why;
  }

  const after = await handler.inspect(readerOf(output));
  const survived = after.findings.filter((f) => f.severity !== "benign");
  const literalsFound = await findLiterals(output, sensitiveLiterals(before));

  const verify: VerifyResult = {
    ok: survived.length === 0 && after.assets.length === 0 && literalsFound.length === 0,
    survived,
    survivingAssets: after.assets,
    literalsFound,
    bytesBefore: file.size,
    bytesAfter: output.size,
  };

  return { output, verify, rebuilt, rebuildReason };
}

/**
 * Whether this file has a write path, answerable before the user fills in a
 * profile. ISOBMFF deliberately has none — writing `udta` resizes boxes and
 * puts us back into the chunk-offset problem the strip avoids — so a HEIC
 * straight off an iPhone must be refused clearly rather than silently.
 */
export async function canForge(file: Blob, filename: string): Promise<boolean> {
  const handler = await handlerFor(file, filename);
  return Boolean(handler.spoof);
}

export interface ForgeResult {
  readonly output: Blob;
  /** What the forged file actually reads back as — not what we asked for. */
  readonly readBack: Report;
  readonly lint: LintResult;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

/**
 * Write a forged identity onto a file, then read the result back.
 *
 * The read-back is the point: a writer that reports success without re-parsing
 * its own output is how you end up demoing a file whose EXIF block no reader
 * accepts. The lint runs against what came out, not against the profile that
 * went in.
 */
export async function forgeFile(
  file: Blob,
  filename: string,
  profile: SpoofProfile,
): Promise<ForgeResult> {
  const handler = await handlerFor(file, filename);
  if (!handler.spoof) {
    throw new Error(`${handler.label} has no write path — forging is not supported for it.`);
  }

  const src = readerOf(file);
  const before = await handler.inspect(src);
  const edit = await handler.spoof(src, before, profile);

  const output =
    edit.kind === "patch" ? assemble(file, edit.plan, file.type) : await edit.build();

  const readBack = await handler.inspect(readerOf(output));

  return {
    output,
    readBack,
    lint: lint(readBack, profile),
    bytesBefore: file.size,
    bytesAfter: output.size,
  };
}

/** Extract one embedded asset as its own Blob, for the remnant reveal. */
export function extractAsset(
  file: Blob,
  range: { start: number; end: number },
  mime: string,
): Blob {
  return file.slice(range.start, range.end, mime);
}
