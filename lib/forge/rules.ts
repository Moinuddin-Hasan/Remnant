import type { SpoofProfile } from "../metadata/handler";
import type { Report } from "../metadata/types";
import MODELS from "./data/models.json";

export interface DeviceRecord {
  readonly make: string;
  readonly model: string;
  readonly released: string;
  readonly width?: number;
  readonly height?: number;
}

export interface Contradiction {
  readonly rule: string;
  readonly message: string;
  /** 0..1 — how strongly this betrays the file. */
  readonly weight: number;
  /** Why the same signal can appear on a genuine file. Never omitted. */
  readonly alsoHappensWhen: string;
}

export interface RuleInput {
  readonly report: Report;
  readonly profile?: SpoofProfile;
}

export type Rule = (input: RuleInput) => Contradiction | null;

const devices = MODELS as readonly DeviceRecord[];

export const knownModelCount = devices.length;

const findingValue = (report: Report, id: string): string | undefined =>
  report.findings.find((f) => f.id === id)?.value;

const asNumber = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Parses "+05:30" / "-0800" / "Z" into hours. */
function parseOffset(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (s === "Z" || s === "+00:00") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (!m) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) + Number(m[3]) / 60);
}

/** EXIF "YYYY:MM:DD HH:MM:SS" → Date. */
function parseExifDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (m) {
    return new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6]),
    );
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function lookupDevice(make?: string, model?: string): DeviceRecord | undefined {
  if (!model) return undefined;
  const wanted = model.trim().toLowerCase();
  return devices.find(
    (d) =>
      d.model.toLowerCase() === wanted &&
      (!make || d.make.toLowerCase() === make.trim().toLowerCase()),
  );
}

/**
 * GPS longitude against the recorded timezone offset.
 *
 * Solar time moves 15° per hour, so a longitude implies an offset. This is the
 * classic tell — a forger sets coordinates and forgets the clock — but it is
 * also the single most common *innocent* mismatch, because a traveller's phone
 * often has not switched timezone yet. Tolerance is deliberately wide.
 */
export const gpsVsTimezone: Rule = ({ report, profile }) => {
  const gps = findingValue(report, "exif.gps");
  const lon =
    profile?.longitude ?? (gps ? asNumber(gps.split(",")[1]?.trim()) : undefined);
  const offset =
    parseOffset(profile?.offsetTime) ??
    parseOffset(findingValue(report, "exif.OffsetTimeOriginal"));

  if (lon === undefined || offset === undefined) return null;

  const expected = lon / 15;
  const delta = Math.abs(expected - offset);
  if (delta <= 3) return null;

  return {
    rule: "gps.vs.timezone",
    weight: Math.min(1, delta / 12),
    message:
      `Longitude ${lon.toFixed(2)}° implies roughly UTC${expected >= 0 ? "+" : ""}` +
      `${expected.toFixed(1)}, but the recorded offset is UTC${offset >= 0 ? "+" : ""}` +
      `${offset.toFixed(1)} — ${delta.toFixed(1)} hours apart.`,
    alsoHappensWhen:
      "a traveller's phone has not updated its timezone yet, which is extremely common.",
  };
};

/** Capture date earlier than the claimed camera existed. */
export const dateVsModel: Rule = ({ report, profile }) => {
  const make = profile?.make ?? findingValue(report, "exif.Make");
  const model = profile?.model ?? findingValue(report, "exif.Model");
  const device = lookupDevice(make, model);
  if (!device) return null;

  const taken = parseExifDate(profile?.dateTime ?? findingValue(report, "exif.DateTimeOriginal"));
  if (!taken) return null;

  const released = new Date(device.released);
  if (taken >= released) return null;

  const days = Math.round((released.getTime() - taken.getTime()) / 86_400_000);
  return {
    rule: "date.vs.model",
    weight: Math.min(1, days / 365),
    message:
      `Capture date ${taken.toISOString().slice(0, 10)} is ${days} days before the ` +
      `${device.make} ${device.model} was released (${device.released}).`,
    alsoHappensWhen:
      "the camera clock was never set, or the unit was a pre-release press loan.",
  };
};

/** Model string that does not belong to the claimed manufacturer. */
export const makeVsModel: Rule = ({ report, profile }) => {
  const make = profile?.make ?? findingValue(report, "exif.Make");
  const model = profile?.model ?? findingValue(report, "exif.Model");
  if (!make || !model) return null;

  const byModel = devices.find((d) => d.model.toLowerCase() === model.trim().toLowerCase());
  if (!byModel) return null;
  if (byModel.make.toLowerCase() === make.trim().toLowerCase()) return null;

  return {
    rule: "make.vs.model",
    weight: 0.9,
    message: `Model "${model}" is a ${byModel.make} device, but Make says "${make}".`,
    alsoHappensWhen: "almost never — this pairing is fixed by the manufacturer.",
  };
};

/**
 * A vendor MakerNote or vendor APP segment left behind from the original
 * camera while the claimed Make is somebody else's.
 */
const VENDORS = [
  "apple", "samsung", "nikon", "canon", "sony", "google",
  "fujifilm", "xiaomi", "olympus", "panasonic", "leica", "gopro",
] as const;

/**
 * Which vendor a Make string belongs to.
 *
 * Manufacturers do not write their own name plainly: Nikon writes
 * "NIKON CORPORATION", Samsung writes lowercase "samsung", Sony writes "SONY".
 * Comparing a Make against a vendor token with `===` therefore fails on the
 * ones that matter, which is how every Nikon forgery ended up being accused of
 * carrying Nikon data.
 */
const vendorOf = (s: string): string | null =>
  VENDORS.find((v) => s.toLowerCase().includes(v)) ?? null;

/** Fields the profile itself writes. Leftover data means anything BUT these. */
const WRITTEN_BY_PROFILE = new Set([
  "exif.Make",
  "exif.Model",
  "exif.Software",
  "exif.Artist",
  "exif.DateTimeOriginal",
  "exif.CreateDate",
  "exif.ModifyDate",
  "exif.OffsetTimeOriginal",
  "exif.gps",
]);

export const makeVsResidue: Rule = ({ report, profile }) => {
  const make = profile?.make ?? findingValue(report, "exif.Make") ?? "";
  const claimed = vendorOf(make);
  if (!claimed) return null;

  const residue = report.findings.filter((f) => {
    // The values we deliberately wrote are not residue — residue is what an
    // earlier camera left behind.
    if (WRITTEN_BY_PROFILE.has(f.id)) return false;
    const hay = `${f.label} ${f.value}`.toLowerCase();
    return VENDORS.some((v) => v !== claimed && hay.includes(v));
  });
  if (residue.length === 0) return null;

  return {
    rule: "make.vs.residue",
    weight: 0.85,
    message:
      `The file still carries vendor data from another manufacturer while claiming ` +
      `"${profile?.make ?? make}": ${residue.map((r) => r.label).join(", ")}.`,
    alsoHappensWhen:
      "an editor from a different vendor processed the image and left its own tags.",
  };
};

/** Our own writer's structural signature. Reported rather than hidden. */
export const writerSignature: Rule = ({ profile }) => {
  if (!profile) return null;
  return {
    rule: "writer.signature",
    weight: 0.4,
    message:
      "This EXIF block was written big-endian with a minimal IFD layout and no MakerNote. " +
      "Most phone cameras write little-endian and include vendor tags, so the structure " +
      "itself is identifiable as tool-generated.",
    alsoHappensWhen:
      "any metadata editor rewrites a file — the signature identifies the tool, not a lie.",
  };
};

export const RULES: readonly Rule[] = [
  gpsVsTimezone,
  dateVsModel,
  makeVsModel,
  makeVsResidue,
  writerSignature,
];
