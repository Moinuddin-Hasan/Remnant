/** Half-open byte interval: [start, end). */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export const rangeLength = (r: ByteRange): number => r.end - r.start;

export type FormatId = "jpeg" | "png" | "webp" | "isobmff" | "pdf" | "ooxml" | "zip" | "unknown";

/**
 * Tier is DERIVED from which handler methods exist, never declared. A handler
 * cannot claim it can strip a format without shipping a `plan`.
 *   1 = read + strip + spoof
 *   2 = read + strip
 *   3 = read only, and says so
 */
export type Tier = 1 | 2 | 3;

export type FindingGroup =
  | "identity"
  | "location"
  | "device"
  | "time"
  | "software"
  | "history"
  | "remnant";

/** `critical` leaks who or where you are. `notable` narrows it. `benign` survives a strip. */
export type Severity = "critical" | "notable" | "benign";

export interface Finding {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly group: FindingGroup;
  readonly severity: Severity;
  readonly range?: ByteRange;
}

export type AssetKind =
  | "thumbnail"
  | "second-image"
  | "trailer-video"
  | "trailer-data"
  | "doc-thumbnail";

/**
 * The remnant layer: payload inside the file that is neither descriptive
 * metadata nor the content the viewer renders. An EXIF thumbnail that no
 * longer matches the visible frame, the second lens's full-resolution capture
 * in APP2 MPF, the MP4 a phone appends after the end-of-image marker.
 */
export interface EmbeddedAsset {
  readonly kind: AssetKind;
  readonly mime: string;
  readonly range: ByteRange;
  readonly note: string;
}

export interface Report {
  readonly format: FormatId;
  readonly formatLabel: string;
  readonly tier: Tier;
  readonly size: number;
  readonly findings: readonly Finding[];
  readonly assets: readonly EmbeddedAsset[];
  /** What this handler KNOWS it did not inspect. Always rendered, never hidden. */
  readonly unhandled: readonly string[];
}

export const criticalCount = (r: Report): number =>
  r.findings.filter((f) => f.severity !== "benign").length;

export interface StripOptions {
  /** ICC is privacy-benign and colour-relevant. Default: drop it, it can fingerprint a device. */
  readonly keepColorProfile: boolean;
  /** Dropping EXIF rotates phone photos in some viewers. Default: re-add orientation alone. */
  readonly keepOrientation: boolean;
}

export const DEFAULT_STRIP: StripOptions = {
  keepColorProfile: false,
  keepOrientation: true,
};

/** Result of re-reading our own output. The tool may not say "clean" without this. */
export interface VerifyResult {
  readonly ok: boolean;
  readonly survived: readonly Finding[];
  readonly survivingAssets: readonly EmbeddedAsset[];
  readonly literalsFound: readonly string[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}
