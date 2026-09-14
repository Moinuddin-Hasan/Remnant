import { describe, expect, it } from "vitest";
import {
  buildFixtureMp4,
  buildLargesizeMp4,
  buildTimedMetaMp4,
  fixtureAvif,
  fixtureMov,
  ISO_FIXTURE,
} from "../../../../fixtures/isobmff";
import { cleanFile, inspectFile } from "../../pipeline";
import { readerOf } from "../../reader";
import type { Report } from "../../types";
import { flatten, headerTimes, walkTree } from "./boxes";

const asBlob = (b: Uint8Array) => new Blob([b.slice().buffer as ArrayBuffer]);
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const byLabel = (r: Report, re: RegExp) => r.findings.filter((f) => re.test(f.label));
const valueOf = (r: Report, re: RegExp) => byLabel(r, re)[0]?.value;
const treeOf = async (b: Uint8Array) => flatten((await walkTree(readerOf(asBlob(b)))).boxes);

function expectGps(r: Report, source: RegExp) {
  const gps = r.findings.filter((f) => f.group === "location" && source.test(f.label));
  expect(gps.length, `no GPS matching ${source}`).toBeGreaterThan(0);
  for (const g of gps) {
    const [lat, lon] = g.value.split(",").map((v) => Number(v.trim()));
    expect(lat).toBeCloseTo(ISO_FIXTURE.lat, 3);
    expect(lon).toBeCloseTo(ISO_FIXTURE.lon, 3);
  }
}

/** Neutralisation must not move a single byte of media or a single offset. */
async function expectNeutralised(input: Uint8Array, name: string) {
  const { output, verify } = await cleanFile(asBlob(input), name);
  const out = await bytesOf(output);
  expect(verify.survived.map((f) => f.label)).toEqual([]);
  expect(verify.literalsFound).toEqual([]);
  expect(verify.ok).toBe(true);
  expect(out.length, "size must not change").toBe(input.length);

  const before = await treeOf(input);
  const after = await treeOf(out);
  // Same box layout at the same offsets; metadata boxes became `free`.
  expect(after.filter((b) => b.parent === "").map((b) => [b.start, b.end])).toEqual(
    before.filter((b) => b.parent === "").map((b) => [b.start, b.end]),
  );
  for (const b of before.filter((x) => ["udta", "uuid"].includes(x.type))) {
    const same = after.find((a) => a.start === b.start);
    expect(same?.type, `${b.path} at ${b.start}`).toBe("free");
    expect(same?.end).toBe(b.end);
  }
  // mdat and the whole sample table (stco/stsz/stsc/stts) are bit-identical.
  for (const type of ["mdat", "stbl"]) {
    const a = before.find((b) => b.type === type)!;
    expect(Array.from(out.subarray(a.start, a.end)), type).toEqual(Array.from(input.subarray(a.start, a.end)));
  }
  // Every header timestamp is zero.
  for (const b of after.filter((x) => ["mvhd", "tkhd", "mdhd"].includes(x.type))) {
    const t = await headerTimes(readerOf(output), b);
    expect([t?.created, t?.modified], b.path).toEqual([0, 0]);
  }
  return out;
}

describe("mp4 written by ffmpeg (mdta keys, loci, XMP uuid)", () => {
  const mp4 = buildFixtureMp4();

  it("is picked by the registry as a strippable format", async () => {
    const { report, canClean } = await inspectFile(asBlob(mp4), "clip.mp4");
    expect(report.format).toBe("isobmff");
    expect(report.formatLabel).toBe("MP4 video");
    expect(canClean).toBe(true);
  });

  it("reads GPS from the Apple key, the generic key and 3GPP loci", async () => {
    const { report } = await inspectFile(asBlob(mp4), "clip.mp4");
    expectGps(report, /ISO6709/);
    expectGps(report, /\(location\)/);
    expectGps(report, /loci/);
  });

  it("reads make, model, encoder, recording time and the XMP creator", async () => {
    const { report } = await inspectFile(asBlob(mp4), "clip.mp4");
    expect(valueOf(report, /^Camera make$/)).toBe(ISO_FIXTURE.make);
    expect(valueOf(report, /^Camera model$/)).toBe(ISO_FIXTURE.model);
    expect(report.findings.map((f) => f.value)).toContain(ISO_FIXTURE.encoder);
    expect(valueOf(report, /movie header/)).toContain(ISO_FIXTURE.created);
    expect(valueOf(report, /track and media/)).toContain(ISO_FIXTURE.created);
    expect(valueOf(report, /Creator \(XMP\)/)).toBe(ISO_FIXTURE.xmpCreator);
  });

  it("gives every finding a unique id and says neutralised, not deleted", async () => {
    const { report } = await inspectFile(asBlob(mp4), "clip.mp4");
    const ids = report.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(report.unhandled.join(" ")).toMatch(/Neutralised, not deleted/);
  });

  it("neutralises in place: zero size delta, offsets and media untouched", async () => {
    await expectNeutralised(mp4, "clip.mp4");
  });
});

describe("mov written by ffmpeg (QuickTime udta atoms)", () => {
  const mov = fixtureMov();

  it("reads ©xyz GPS and the ©mak / ©mod / ©swr atoms", async () => {
    const { report } = await inspectFile(asBlob(mov), "clip.mov");
    expect(report.formatLabel).toBe("QuickTime movie");
    expectGps(report, /©xyz/);
    expect(valueOf(report, /^Camera make$/)).toBe(ISO_FIXTURE.make);
    expect(valueOf(report, /^Camera model$/)).toBe(ISO_FIXTURE.model);
    expect(valueOf(report, /^Software$/)).toBe(ISO_FIXTURE.encoder);
  });

  it("neutralises in place", async () => {
    await expectNeutralised(mov, "clip.mov");
  });
});

describe("64-bit box sizes", () => {
  it("walks a largesize mdat and zeroes version-1 times", async () => {
    const file = buildLargesizeMp4();
    const tree = await treeOf(file);
    expect(tree.map((b) => b.type)).toEqual(["ftyp", "mdat", "moov", "mvhd", "udta", "©mak"]);
    const { report } = await inspectFile(asBlob(file), "large.mp4");
    expect(valueOf(report, /movie header/)).toContain(ISO_FIXTURE.created);
    const { verify, output } = await cleanFile(asBlob(file), "large.mp4");
    expect(verify.ok).toBe(true);
    expect(output.size).toBe(file.length);
  });
});

describe("timed metadata tracks", () => {
  it("are reported, and the clean honestly comes back partial", async () => {
    const file = buildTimedMetaMp4();
    const { report } = await inspectFile(asBlob(file), "timed.mp4");
    expect(byLabel(report, /Timed metadata track/)).toHaveLength(1);
    const { verify } = await cleanFile(asBlob(file), "timed.mp4");
    expect(verify.ok).toBe(false);
    expect(verify.survived.map((f) => f.label)).toContain("Timed metadata track");
  });
});

describe("heif family", () => {
  it("routes AVIF to the read-only handler with no Clean", async () => {
    const { report, canClean } = await inspectFile(asBlob(fixtureAvif()), "still.avif");
    expect(report.format).toBe("isobmff");
    expect(report.formatLabel).toBe("AVIF image");
    expect(canClean).toBe(false);
    expect(report.tier).toBe(3);
    expect(valueOf(report, /Item structure/)).toMatch(/1 item/);
    expect(report.unhandled.join(" ")).toMatch(/Read-only/);
  });
});
