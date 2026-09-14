import { describe, expect, it } from "vitest";
import { buildFixtureJpeg, FIXTURE_LAT, FIXTURE_LON, FIXTURE_MAKE } from "../../fixtures/build";
import { cleanFile, inspectFile } from "./pipeline";
import { readerOf } from "./reader";
import { walkJpeg, isApp } from "./formats/jpeg/segments";

const fixture = buildFixtureJpeg();
const asBlob = () => new Blob([fixture.bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" });

describe("jpeg marker walk", () => {
  it("finds the APP segments, the EOI and the trailer", async () => {
    const s = await walkJpeg(readerOf(asBlob()));
    expect(s.truncated).toBe(false);
    expect(s.eoi).not.toBeNull();
    // The walk stops at the FIRST EOI, so its raw trailer begins there and
    // still contains the MPF second image. Splitting those two is inspect()'s
    // job, asserted separately below.
    expect(s.trailer).not.toBeNull();
    expect(s.trailer!.start).toBe(s.eoi!.end);
    expect(s.trailer!.start).toBeLessThan(fixture.trailerStart);

    const apps = s.segments.filter((x) => isApp(x.marker));
    const ids = apps.map((a) => a.identifier ?? "");
    expect(ids.some((i) => i.startsWith("Exif"))).toBe(true);
    expect(ids.some((i) => i.startsWith("MPF"))).toBe(true);
  });
});

describe("inspect", () => {
  it("reads GPS, make and model out of the EXIF block", async () => {
    const { report } = await inspectFile(asBlob(), "fixture.jpg");
    const gps = report.findings.find((f) => f.id === "exif.gps");
    expect(gps, "GPS finding missing").toBeDefined();

    const [lat, lon] = gps!.value.split(",").map((v) => Number(v.trim()));
    expect(lat).toBeCloseTo(FIXTURE_LAT, 3);
    expect(lon).toBeCloseTo(FIXTURE_LON, 3);

    expect(report.findings.find((f) => f.id === "exif.Make")?.value).toBe(FIXTURE_MAKE);
  });

  it("surfaces the hidden second image from APP2 MPF", async () => {
    const { report } = await inspectFile(asBlob(), "fixture.jpg");
    const second = report.assets.find((a) => a.kind === "second-image");
    expect(second, "MPF second image not found").toBeDefined();
    expect(second!.range.start).toBe(fixture.secondImageRange.start);
    expect(second!.range.end).toBe(fixture.secondImageRange.end);
  });

  it("surfaces the video appended after the end-of-image marker", async () => {
    const { report } = await inspectFile(asBlob(), "fixture.jpg");
    const trailer = report.assets.find((a) => a.kind === "trailer-video");
    expect(trailer, "trailer video not found").toBeDefined();
    expect(trailer!.range.start).toBe(fixture.trailerStart);
  });

  it("always reports what it did not inspect", async () => {
    const { report } = await inspectFile(asBlob(), "fixture.jpg");
    expect(report.unhandled.length).toBeGreaterThan(0);
  });
});

describe("clean", () => {
  it("removes everything and verifies its own output", async () => {
    const { verify } = await cleanFile(asBlob(), "fixture.jpg");
    expect(verify.survived, `survived: ${verify.survived.map((f) => f.label).join(", ")}`).toEqual([]);
    expect(verify.survivingAssets).toEqual([]);
    expect(verify.literalsFound).toEqual([]);
    expect(verify.ok).toBe(true);
    expect(verify.bytesAfter).toBeLessThan(verify.bytesBefore);
  });

  it("leaves the compressed image data bit-identical", async () => {
    const src = asBlob();
    const { output } = await cleanFile(src, "fixture.jpg");
    const out = new Uint8Array(await output.arrayBuffer());

    // Locate the scan in both files and compare it byte for byte.
    const scanOf = async (blob: Blob) => {
      const s = await walkJpeg(readerOf(blob));
      const sos = s.segments.find((x) => x.marker === 0xda);
      expect(sos).toBeDefined();
      return new Uint8Array(await blob.slice(sos!.start, sos!.end).arrayBuffer());
    };

    const a = await scanOf(src);
    const b = await scanOf(new Blob([out.slice().buffer as ArrayBuffer]));
    expect(b.length).toBe(a.length);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it("produces a file that still starts with SOI and ends at EOI", async () => {
    const { output } = await cleanFile(asBlob(), "fixture.jpg");
    const out = new Uint8Array(await output.arrayBuffer());
    expect([out[0], out[1]]).toEqual([0xff, 0xd8]);
    expect([out[out.length - 2], out[out.length - 1]]).toEqual([0xff, 0xd9]);
  });
});

describe("unknown binaries", () => {
  it("finds UTF-16LE Windows paths and refuses to claim a clean", async () => {
    const ascii = "harmless";
    const path = "C:\\Users\\Asus\\secret";
    const buf: number[] = [0x00, 0x01, 0x02, 0x03];
    for (const ch of ascii) buf.push(ch.charCodeAt(0));
    for (const ch of path) {
      buf.push(ch.charCodeAt(0));
      buf.push(0x00); // UTF-16LE
    }
    const blob = new Blob([new Uint8Array(buf).buffer as ArrayBuffer]);

    const { report, canClean } = await inspectFile(blob, "mystery.bin");
    expect(report.format).toBe("unknown");
    expect(canClean).toBe(false);
    expect(report.tier).toBe(3);
    const hit = report.findings.find((f) => f.value.includes("C:\\Users\\Asus"));
    expect(hit, "UTF-16LE path not detected").toBeDefined();
  });
});
