import { describe, expect, it } from "vitest";
import { buildFixtureJpeg } from "../../fixtures/build";
import { cleanFile, forgeFile, inspectFile } from "../metadata/pipeline";
import { lint } from "./lint";
import type { SpoofProfile } from "../metadata/handler";

const fixture = buildFixtureJpeg();
const dirty = () => new Blob([fixture.bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" });

async function cleanBlob(): Promise<Blob> {
  const { output } = await cleanFile(dirty(), "fixture.jpg");
  return output;
}

const PROFILE: SpoofProfile = {
  make: "Apple",
  model: "iPhone 15 Pro",
  software: "17.4.1",
  artist: "Nobody",
  dateTime: "2024:06:01 14:30:00",
  offsetTime: "+05:30",
  latitude: 12.9716,
  longitude: 79.1588,
};

describe("forge", () => {
  it("writes EXIF that reads back with the values we asked for", async () => {
    const { readBack } = await forgeFile(await cleanBlob(), "clean.jpg", PROFILE);

    const value = (id: string) => readBack.findings.find((f) => f.id === id)?.value;
    expect(value("exif.Make")).toBe("Apple");
    expect(value("exif.Model")).toBe("iPhone 15 Pro");
    expect(value("exif.Artist")).toBe("Nobody");
    expect(value("exif.Software")).toBe("17.4.1");

    const gps = value("exif.gps");
    expect(gps, "forged GPS did not read back").toBeDefined();
    const [lat, lon] = gps!.split(",").map((v) => Number(v.trim()));
    expect(lat).toBeCloseTo(12.9716, 3);
    expect(lon).toBeCloseTo(79.1588, 3);
  });

  it("writes a capture timestamp readable as DateTimeOriginal", async () => {
    const { readBack } = await forgeFile(await cleanBlob(), "clean.jpg", PROFILE);
    const taken = readBack.findings.find((f) => f.id === "exif.DateTimeOriginal")?.value;
    expect(taken).toBeDefined();
    expect(taken).toContain("2024");
  });

  it("produces a structurally valid JPEG", async () => {
    const { output } = await forgeFile(await cleanBlob(), "clean.jpg", PROFILE);
    const bytes = new Uint8Array(await output.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect([bytes[bytes.length - 2], bytes[bytes.length - 1]]).toEqual([0xff, 0xd9]);
  });

  it("forging a dirty file drops the original metadata and the remnant payload", async () => {
    // Forging straight onto the untouched fixture must not leave the real
    // camera's data sitting beside the forged block.
    const { readBack, output } = await forgeFile(dirty(), "fixture.jpg", PROFILE);
    expect(readBack.findings.find((f) => f.id === "exif.Make")?.value).toBe("Apple");
    expect(readBack.assets.filter((a) => a.kind === "second-image")).toEqual([]);
    expect(readBack.assets.filter((a) => a.kind === "trailer-video")).toEqual([]);
    expect(output.size).toBeLessThan(fixture.bytes.length);
  });
});

describe("lint", () => {
  it("catches GPS that disagrees with the timezone offset", async () => {
    const bad: SpoofProfile = { ...PROFILE, longitude: -74.006, latitude: 40.7128 };
    const { lint: result } = await forgeFile(await cleanBlob(), "clean.jpg", bad);
    const hit = result.contradictions.find((c) => c.rule === "gps.vs.timezone");
    expect(hit, "timezone contradiction not caught").toBeDefined();
    expect(hit!.alsoHappensWhen).toBeTruthy();
  });

  it("accepts GPS that agrees with the offset", async () => {
    const { lint: result } = await forgeFile(await cleanBlob(), "clean.jpg", PROFILE);
    expect(result.contradictions.find((c) => c.rule === "gps.vs.timezone")).toBeUndefined();
  });

  it("catches a capture date before the claimed model shipped", async () => {
    const bad: SpoofProfile = { ...PROFILE, dateTime: "2019:01:01 09:00:00" };
    const { lint: result } = await forgeFile(await cleanBlob(), "clean.jpg", bad);
    const hit = result.contradictions.find((c) => c.rule === "date.vs.model");
    expect(hit, "release-date contradiction not caught").toBeDefined();
    expect(hit!.message).toContain("iPhone 15 Pro");
  });

  it("catches a model that belongs to a different manufacturer", async () => {
    const bad: SpoofProfile = { ...PROFILE, make: "Canon" };
    const { lint: result } = await forgeFile(await cleanBlob(), "clean.jpg", bad);
    expect(result.contradictions.find((c) => c.rule === "make.vs.model")).toBeDefined();
  });

  it("always reports its own writer signature and what it cannot reach", async () => {
    const { lint: result } = await forgeFile(await cleanBlob(), "clean.jpg", PROFILE);
    expect(result.contradictions.find((c) => c.rule === "writer.signature")).toBeDefined();
    expect(result.outOfReach.length).toBeGreaterThan(0);
    expect(result.checkedModels).toBeGreaterThan(0);
  });

  it("runs as a detector on a received file with no profile", async () => {
    const { report } = await inspectFile(dirty(), "fixture.jpg");
    const result = lint(report);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    // No profile means no forge signature to report.
    expect(result.contradictions.find((c) => c.rule === "writer.signature")).toBeUndefined();
  });

  it("scores a coherent forgery above a self-contradicting one", async () => {
    const good = await forgeFile(await cleanBlob(), "clean.jpg", PROFILE);
    const bad = await forgeFile(await cleanBlob(), "clean.jpg", {
      ...PROFILE,
      make: "Canon",
      dateTime: "2019:01:01 09:00:00",
      longitude: -74.006,
    });
    expect(good.lint.score).toBeGreaterThan(bad.lint.score);
  });
});
