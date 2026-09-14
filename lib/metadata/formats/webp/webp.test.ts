import { describe, expect, it } from "vitest";
import { baseWebp, buildFixtureWebp, WEBP_FIXTURE } from "../../../../fixtures/webp";
import { cleanFile, inspectFile } from "../../pipeline";
import { readerOf } from "../../reader";
import { DEFAULT_STRIP } from "../../types";
import { walkWebp } from ".";

const fixture = buildFixtureWebp();
const asBlob = (b: Uint8Array = fixture.bytes) =>
  new Blob([b.slice().buffer as ArrayBuffer], { type: "image/webp" });
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const find = (report: { findings: readonly { id: string; value: string }[] }, id: string) =>
  report.findings.find((f) => f.id === id || f.id.startsWith(`${id}.`));

/** The container invariants a strict decoder checks. */
async function assertWellFormed(out: Uint8Array) {
  const view = new DataView(out.buffer, out.byteOffset);
  expect(view.getUint32(4, true), "RIFF size").toBe(out.length - 8);
  const s = await walkWebp(readerOf(new Blob([out.slice().buffer as ArrayBuffer])));
  expect(s.unparsed).toBeNull();
  expect(s.trailer).toBeNull();
  const last = s.chunks[s.chunks.length - 1]!;
  expect(last.end).toBe(out.length);
  return s;
}

describe("webp inspect", () => {
  it("is picked by the registry and reads EXIF, XMP and ICCP", async () => {
    const { report, canClean } = await inspectFile(asBlob(), "fixture.webp");
    expect(report.format).toBe("webp");
    expect(canClean).toBe(true);
    expect(find(report, "exif.Make")?.value).toBe(WEBP_FIXTURE.make);
    expect(find(report, "exif.Model")?.value).toBe(WEBP_FIXTURE.model);
    expect(find(report, "xmp.creator")?.value).toBe(WEBP_FIXTURE.xmpCreator);
    expect(find(report, "webp.ICCP")).toBeDefined();
    for (const id of ["exif.gps", "xmp.gps"]) {
      const [lat, lon] = find(report, id)!.value.split(",").map((v) => Number(v.trim()));
      expect(lat, id).toBeCloseTo(WEBP_FIXTURE.lat, 3);
      expect(lon, id).toBeCloseTo(WEBP_FIXTURE.lon, 3);
    }
  });

  it("walks past the odd-length ICCP pad byte", async () => {
    const s = await walkWebp(readerOf(asBlob()));
    expect(s.chunks.map((c) => c.fourcc)).toEqual(["VP8X", "ICCP", "VP8 ", "EXIF", "XMP "]);
    expect(s.unparsed).toBeNull();
  });

  it("reports bytes after the declared RIFF end", async () => {
    const { report } = await inspectFile(asBlob(), "fixture.webp");
    const t = report.assets.find((a) => a.kind === "trailer-data");
    expect(t?.range.start).toBe(fixture.trailerStart);
  });

  it("reports nothing on a plain WebP", async () => {
    const { report } = await inspectFile(asBlob(baseWebp()), "plain.webp");
    expect(report.findings).toEqual([]);
    expect(report.assets).toEqual([]);
  });
});

describe("webp clean", () => {
  it("strips to zero findings and verifies its own output", async () => {
    const { verify } = await cleanFile(asBlob(), "fixture.webp");
    expect(verify.survived.map((f) => f.label)).toEqual([]);
    expect(verify.survivingAssets).toEqual([]);
    expect(verify.literalsFound).toEqual([]);
    expect(verify.ok).toBe(true);
  });

  it("clears the VP8X flags, fixes the RIFF size and keeps VP8 byte-identical", async () => {
    const out = await bytesOf((await cleanFile(asBlob(), "fixture.webp")).output);
    const s = await assertWellFormed(out);
    expect(s.chunks.map((c) => c.fourcc)).toEqual(["VP8X", "VP8 "]);

    const vp8x = s.chunks[0]!;
    expect(out[vp8x.dataStart], "VP8X flags").toBe(0);

    const vp8 = s.chunks[1]!;
    expect(Array.from(out.subarray(vp8.start, vp8.end))).toEqual(Array.from(fixture.vp8));
  });

  it("keeps ICCP and its flag when the colour profile is kept", async () => {
    const opts = { ...DEFAULT_STRIP, keepColorProfile: true };
    const { output, verify } = await cleanFile(asBlob(), "fixture.webp", opts);
    const out = await bytesOf(output);
    const s = await assertWellFormed(out);
    expect(s.chunks.map((c) => c.fourcc)).toEqual(["VP8X", "ICCP", "VP8 "]);
    expect(out[s.chunks[0]!.dataStart]).toBe(0x20);
    expect(verify.ok).toBe(true);
  });

  it("leaves a plain WebP untouched", async () => {
    const plain = baseWebp();
    const { output } = await cleanFile(asBlob(plain), "plain.webp");
    expect(Array.from(await bytesOf(output))).toEqual(Array.from(plain));
  });
});
