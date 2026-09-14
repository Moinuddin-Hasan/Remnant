import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildFixturePng, PNG_FIXTURE } from "../../../../fixtures/png";
import { cleanFile, inspectFile } from "../../pipeline";
import { readerOf } from "../../reader";
import { walkPng } from ".";

const fixture = buildFixturePng();
const asBlob = (b: Uint8Array = fixture.bytes) =>
  new Blob([b.slice().buffer as ArrayBuffer], { type: "image/png" });
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const find = (report: { findings: readonly { id: string; value: string }[] }, id: string) =>
  report.findings.find((f) => f.id === id || f.id.startsWith(`${id}.`));

describe("png inspect", () => {
  it("is picked by the registry and reads every metadata chunk", async () => {
    const { report, canClean } = await inspectFile(asBlob(), "fixture.png");
    expect(report.format).toBe("png");
    expect(canClean).toBe(true);

    const values = report.findings.map((f) => f.value);
    expect(values).toContain(PNG_FIXTURE.author);
    expect(values).toContain(PNG_FIXTURE.software);
    expect(values, "zTXt was not inflated").toContain(PNG_FIXTURE.comment);
    expect(find(report, "exif.Make")?.value).toBe(PNG_FIXTURE.make);
    expect(find(report, "xmp.creator")?.value).toBe(PNG_FIXTURE.xmpCreator);
    expect(find(report, "png.tIME")?.value).toBe(PNG_FIXTURE.time);
    expect(find(report, "png.iCCP")?.value).toContain(PNG_FIXTURE.iccName);
  });

  it("reads GPS out of both the eXIf chunk and the XMP packet", async () => {
    const { report } = await inspectFile(asBlob(), "fixture.png");
    for (const id of ["exif.gps", "xmp.gps"]) {
      const [lat, lon] = find(report, id)!.value.split(",").map((v) => Number(v.trim()));
      expect(lat, id).toBeCloseTo(PNG_FIXTURE.lat, 3);
      expect(lon, id).toBeCloseTo(PNG_FIXTURE.lon, 3);
    }
  });

  it("flags leftover image data after IEND as the aCropalypse pattern", async () => {
    const { report } = await inspectFile(asBlob(), "fixture.png");
    const trailer = report.assets.find((a) => a.kind === "trailer-data");
    expect(trailer?.range.start).toBe(fixture.trailerStart);
    expect(trailer?.note).toMatch(/aCropalypse/);
    expect(find(report, "png.trailer")?.value).toBeDefined();
  });

  it("gives every finding a unique id", async () => {
    const { report } = await inspectFile(asBlob(), "fixture.png");
    const ids = report.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("survives a truncated file and reports the unparsed tail", async () => {
    const cut = fixture.bytes.subarray(0, fixture.idatRange.start + 20);
    const { report } = await inspectFile(asBlob(cut), "cut.png");
    expect(find(report, "png.unparsed")).toBeDefined();
    expect(report.unhandled.join(" ")).toMatch(/truncated/);
  });
});

describe("png clean", () => {
  it("strips to zero findings and verifies its own output", async () => {
    const { verify } = await cleanFile(asBlob(), "fixture.png");
    expect(verify.survived.map((f) => f.label)).toEqual([]);
    expect(verify.survivingAssets).toEqual([]);
    expect(verify.literalsFound).toEqual([]);
    expect(verify.ok).toBe(true);
  });

  it("leaves IHDR and every IDAT byte identical, and ends at IEND", async () => {
    const { output } = await cleanFile(asBlob(), "fixture.png");
    const out = await bytesOf(output);
    const s = await walkPng(readerOf(output));
    expect(s.trailer).toBeNull();
    expect(s.chunks.map((c) => c.type)).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);

    const idat = s.chunks.find((c) => c.type === "IDAT")!;
    const before = fixture.bytes.subarray(fixture.idatRange.start, fixture.idatRange.end);
    expect(Array.from(out.subarray(idat.start, idat.end))).toEqual(Array.from(before));
  });

  it("produces a file whose every chunk CRC is still valid", async () => {
    const { output } = await cleanFile(asBlob(), "fixture.png");
    const out = await bytesOf(output);
    for (const c of (await walkPng(readerOf(output))).chunks) {
      const stored = new DataView(out.buffer, out.byteOffset).getUint32(c.dataEnd);
      expect(crc32(out.subarray(c.start + 4, c.dataEnd)), c.type).toBe(stored);
    }
  });

  it("keeps the colour profile only when asked to", async () => {
    const kept = await cleanFile(asBlob(), "fixture.png", { keepColorProfile: true, keepOrientation: true });
    const types = (await walkPng(readerOf(kept.output))).chunks.map((c) => c.type);
    expect(types).toContain("iCCP");
    // iCCP is benign, so keeping it must not flip the verdict to "partially cleaned".
    expect(kept.verify.ok).toBe(true);
  });
});
