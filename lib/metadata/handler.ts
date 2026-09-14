import type { Reader } from "./reader";
import type { Edit } from "./patch";
import type { FormatId, Report, StripOptions, Tier } from "./types";

export interface SpoofProfile {
  readonly make?: string;
  readonly model?: string;
  readonly dateTime?: string;
  /** EXIF OffsetTimeOriginal, e.g. "+05:30". Checked against GPS longitude by the linter. */
  readonly offsetTime?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly software?: string;
  readonly artist?: string;
}

export interface FormatHandler {
  readonly id: FormatId;
  readonly label: string;
  /** Pure, synchronous, given the first 4 KB. Never reads the network or the disk. */
  sniff(head: Uint8Array, filename: string): boolean;
  inspect(src: Reader): Promise<Report>;
  /** Absent ⇒ this format is Tier 3 and the UI must not offer a clean. */
  plan?(src: Reader, report: Report, opts: StripOptions): Promise<Edit>;
  /** Absent ⇒ Tier 2. */
  spoof?(src: Reader, report: Report, profile: SpoofProfile): Promise<Edit>;
}

/**
 * Tier is derived, never declared, so a handler cannot advertise a capability
 * it has not implemented. If someone adds a format and forgets `plan`, the UI
 * automatically degrades to "we can read this but not clean it" rather than
 * silently handing back an unmodified file under a Clean button.
 */
export function tierOf(h: FormatHandler): Tier {
  if (h.plan && h.spoof) return 1;
  if (h.plan) return 2;
  return 3;
}
