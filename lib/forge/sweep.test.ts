import { describe, expect, it } from "vitest";
import { buildFixtureJpeg } from "../../fixtures/build";
import { canForge, cleanFile, forgeFile } from "../metadata/pipeline";
import { lint } from "./lint";
import MODELS from "./data/models.json";

const dirty = () =>
  new Blob([buildFixtureJpeg().bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" });

const PROFILE = {
  software: "1.0",
  dateTime: "2026:01:15 12:00:00",
  offsetTime: "+05:30",
  latitude: 12.9716,
  longitude: 79.1588,
} as const;

describe("forge sweep over the whole device table", () => {
  /**
   * The regression this exists for: every Nikon device used to be accused of
   * carrying Nikon data, because Nikon writes its Make as "NIKON CORPORATION"
   * and the rule compared that to the bare token "nikon" with `!==`. A false
   * accusation against a correctly-built file is the worst output this feature
   * has, so the whole table is swept rather than one representative device.
   */
  it("a well-formed profile produces no contradiction beyond the writer signature", async () => {
    const { output: clean } = await cleanFile(dirty(), "f.jpg");
    const problems: string[] = [];

    for (const d of MODELS as ReadonlyArray<{ make: string; model: string }>) {
      const { lint: result, readBack } = await forgeFile(clean, "f.jpg", {
        ...PROFILE,
        make: d.make,
        model: d.model,
      });

      const readModel = readBack.findings.find((f) => f.id === "exif.Model")?.value;
      if (readModel !== d.model) problems.push(`${d.make}/${d.model}: read back as "${readModel}"`);

      const readMake = readBack.findings.find((f) => f.id === "exif.Make")?.value;
      if (readMake !== d.make) problems.push(`${d.make}/${d.model}: make read back as "${readMake}"`);

      for (const c of result.contradictions) {
        if (c.rule === "writer.signature") continue;
        problems.push(`${d.make}/${d.model}: ${c.rule} — ${c.message}`);
      }
    }

    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  }, 180_000);

  it("covers every vendor family in the table", () => {
    const makes = new Set((MODELS as ReadonlyArray<{ make: string }>).map((d) => d.make));
    expect(makes.size).toBeGreaterThanOrEqual(5);
    expect(MODELS.length).toBeGreaterThanOrEqual(80);
  });
});

describe("residue detection still works", () => {
  /**
   * The fix narrowed the rule; this proves it did not blind it. A file that
   * genuinely carries another vendor's leftovers must still be caught.
   */
  it("catches a foreign vendor's leftover data", () => {
    const report = {
      format: "jpeg" as const,
      formatLabel: "JPEG image",
      tier: 1 as const,
      size: 1000,
      assets: [],
      unhandled: [],
      findings: [
        { id: "exif.Make", label: "Camera make", value: "NIKON CORPORATION", group: "device" as const, severity: "notable" as const },
        { id: "exif.Model", label: "Camera model", value: "NIKON Z 6", group: "device" as const, severity: "notable" as const },
        { id: "jpeg.makernote", label: "MakerNote", value: "Apple iOS 17.4 capture data", group: "device" as const, severity: "notable" as const },
      ],
    };

    const hit = lint(report, { make: "NIKON CORPORATION", model: "NIKON Z 6" }).contradictions
      .find((c) => c.rule === "make.vs.residue");
    expect(hit, "a genuine Apple MakerNote on a Nikon file was not caught").toBeDefined();
    expect(hit!.message).toContain("MakerNote");
  });

  it("does not treat the fields the profile itself wrote as residue", () => {
    const report = {
      format: "jpeg" as const,
      formatLabel: "JPEG image",
      tier: 1 as const,
      size: 1000,
      assets: [],
      unhandled: [],
      findings: [
        { id: "exif.Make", label: "Camera make", value: "NIKON CORPORATION", group: "device" as const, severity: "notable" as const },
        { id: "exif.Model", label: "Camera model", value: "NIKON Z 6", group: "device" as const, severity: "notable" as const },
      ],
    };

    const hit = lint(report, { make: "NIKON CORPORATION", model: "NIKON Z 6" }).contradictions
      .find((c) => c.rule === "make.vs.residue");
    expect(hit).toBeUndefined();
  });
});

describe("forging across the formats a phone actually produces", () => {
  const profile = { ...PROFILE, make: "Apple", model: "iPhone 15 Pro" };

  it("forges a JPEG", async () => {
    const { readBack } = await forgeFile(dirty(), "p.jpg", profile);
    expect(readBack.findings.find((f) => f.id === "exif.Model")?.value).toBe("iPhone 15 Pro");
  });

  it("forges a PNG", async () => {
    const { buildFixturePng } = await import("../../fixtures/png");
    const bytes = buildFixturePng().bytes;
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/png" });
    const { readBack } = await forgeFile(blob, "p.png", profile);
    expect(readBack.findings.find((f) => f.id === "exif.Model")?.value).toBe("iPhone 15 Pro");
  });

  it("forges a WebP", async () => {
    const { buildFixtureWebp } = await import("../../fixtures/webp");
    const bytes = buildFixtureWebp().bytes;
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/webp" });
    const { readBack } = await forgeFile(blob, "p.webp", profile);
    expect(readBack.findings.find((f) => f.id === "exif.Model")?.value).toBe("iPhone 15 Pro");
  });

  /**
   * An iPhone shoots HEIC by default, so this is the single most likely file a
   * user will hand the forge. It has no write path, and the failure must be a
   * clear refusal rather than a silent no-op or a corrupt file.
   */
  it("refuses a HEIF-family image with a message naming the format", async () => {
    const { fixtureAvif } = await import("../../fixtures/isobmff");
    const blob = new Blob([fixtureAvif().slice().buffer as ArrayBuffer], { type: "image/avif" });
    await expect(forgeFile(blob, "p.avif", profile)).rejects.toThrow(/no write path|not supported/i);
  });

  it("refuses an MP4 rather than corrupting it", async () => {
    const { buildFixtureMp4 } = await import("../../fixtures/isobmff");
    const blob = new Blob([buildFixtureMp4().slice().buffer as ArrayBuffer], { type: "video/mp4" });
    await expect(forgeFile(blob, "p.mp4", profile)).rejects.toThrow(/no write path|not supported/i);
  });

  /** So the UI can say so before the user fills in a profile and clicks. */
  it("reports up front which formats can be forged", async () => {
    const { fixtureAvif } = await import("../../fixtures/isobmff");
    expect(await canForge(dirty(), "p.jpg")).toBe(true);
    const avif = new Blob([fixtureAvif().slice().buffer as ArrayBuffer]);
    expect(await canForge(avif, "p.avif")).toBe(false);
  });
});
