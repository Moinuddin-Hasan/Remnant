import type { ByteRange } from "./types";

export type Patch =
  | { readonly kind: "drop"; readonly range: ByteRange }
  | { readonly kind: "replace"; readonly range: ByteRange; readonly bytes: Uint8Array };

export interface EditPlan {
  readonly patches: readonly Patch[];
  readonly sizeDelta: number;
}

export type Edit =
  | { readonly kind: "patch"; readonly plan: EditPlan }
  /**
   * Honest escape hatch for containers that genuinely cannot be patched in
   * place — a ZIP central directory or a PDF object graph has to be rebuilt.
   * `why` is surfaced in the UI so the user knows the bytes were reconstructed
   * rather than surgically edited.
   */
  | { readonly kind: "rebuild"; readonly build: () => Promise<Blob>; readonly why: string };

export function planOf(patches: readonly Patch[]): EditPlan {
  const sizeDelta = patches.reduce((acc, p) => {
    const len = p.range.end - p.range.start;
    return acc + (p.kind === "drop" ? -len : p.bytes.length - len);
  }, 0);
  return { patches, sizeDelta };
}

/**
 * Throws if the plan is not a sane, ordered, non-overlapping set of edits.
 * Called before every assemble — a silently overlapping plan produces a
 * corrupt file, which is the one failure this tool cannot afford.
 */
export function validatePlan(plan: EditPlan, sourceSize: number): void {
  const sorted = [...plan.patches].sort((a, b) => a.range.start - b.range.start);
  let prevEnd = -1;
  for (const p of sorted) {
    const { start, end } = p.range;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`patch range is not integral: [${start}, ${end})`);
    }
    if (start < 0 || end > sourceSize) {
      throw new Error(`patch [${start}, ${end}) is outside the file (size ${sourceSize})`);
    }
    if (end < start) throw new Error(`patch [${start}, ${end}) ends before it starts`);
    if (start < prevEnd) {
      throw new Error(`patch [${start}, ${end}) overlaps the previous patch ending at ${prevEnd}`);
    }
    prevEnd = end;
  }
}

/**
 * The only writer in the system.
 *
 * Every format handler returns ranges to keep, drop or overwrite; nothing is
 * ever rebuilt from a parsed model. That matters because each library that
 * rebuilds has its own corruption mode — piexifjs rebuilds a binary string,
 * JSZip rebuilds the archive, pdf-lib rebuilds the object graph. Slicing the
 * original means the bytes we do not touch are bit-identical by construction,
 * which is what lets us claim the pixels are untouched.
 */
export function assemble(source: Blob, plan: EditPlan, type?: string): Blob {
  validatePlan(plan, source.size);
  const sorted = [...plan.patches].sort((a, b) => a.range.start - b.range.start);

  const parts: BlobPart[] = [];
  let cursor = 0;
  for (const p of sorted) {
    if (p.range.start > cursor) parts.push(source.slice(cursor, p.range.start));
    if (p.kind === "replace" && p.bytes.length > 0) {
      parts.push(p.bytes.slice().buffer as ArrayBuffer);
    }
    cursor = p.range.end;
  }
  if (cursor < source.size) parts.push(source.slice(cursor));

  return new Blob(parts, { type: type ?? source.type });
}

export const drop = (range: ByteRange): Patch => ({ kind: "drop", range });

export const replace = (range: ByteRange, bytes: Uint8Array): Patch => ({
  kind: "replace",
  range,
  bytes,
});
