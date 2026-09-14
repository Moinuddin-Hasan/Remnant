# Remnant — Implementation Plan

Hackulus 2026 · Cybersecurity Option 3 · Syed Rayyan Azeez (lead), Moinuddin Hasan

Companion documents: `docs/COUNCIL-2026-09-14.md` (the adversarial review this plan is
descoped from), `deck/make_deck.py` (the Review 0 deck).

---

## 0. Confirm before writing code

| Question for SIAM VIT | Why it matters |
|---|---|
| **Is pre-existing code permitted?** | Swings the build from ~93 h to ~20 h. Highest-leverage unknown by a wide margin. |
| Total build hours, and is judging inside or outside the clock? | Decides where the cut line falls in §5. |
| Team size cap | We are two. |
| Submission deliverables and deadline relative to demo | Writeup time is not build time. |
| Live demo, video, or booth crawl? | A booth crawl means the tool runs unattended on judges' own files. |

**Hour-one task, before any product code:** manufacture the demo fixture (§6). If we cannot
produce a file whose remnant payload is visibly different from the rendered image, the demo
does not exist and the whole pitch needs reshaping. Learn that at hour one, not hour thirty.

---

## 1. What we are building

A browser-only tool that reads a file, names everything it discloses, removes what it can
without re-encoding, **re-reads its own output to prove the removal**, and then tells the user
whether any of it mattered for the channel the file is about to travel down.

Three claims we are entitled to make, and nothing beyond them:

- *"We show what we found, and we name what we could not parse."*
- *"Nothing leaves your browser — enforced by the browser, not promised by us."*
- *"After stripping we re-read our own output. If anything survived, we say partially cleaned."*

---

## 2. Repository layout

Separate Vercel project on a subdomain. **Not** inside `projects/portfolio/moinuddinhasan.com/` —
that tree has 13 build gates, a strict production CSP, 16 undeployed commits, and a deploy
script that goes straight to production.

```
remnant/
  app/
    page.tsx                 marketing shell, static
    tool/
      page.tsx               thin server shell; dynamic()s the engine
      layout.tsx             route-scoped CSP header lives here
  components/tool/
    Engine.tsx               'use client', ssr:false — ONLY importer of lib/metadata
    DropZone.tsx  ReportView.tsx  FindingRow.tsx
    RemnantReveal.tsx        the demo moment
    VerifyPanel.tsx  ChannelRouter.tsx  LayerPanel.tsx
  lib/metadata/
    types.ts                 Report, Finding, ByteRange, EmbeddedAsset, FormatId, Tier
    reader.ts                ranged, lazy, zero-copy view over a Blob
    patch.ts                 Patch, EditPlan, assemble(), validatePlan()  ← only writer
    registry.ts              ordered handler list; unknown/ last, always matches
    handler.ts               FormatHandler interface
    scan/strings.ts          latin1 + UTF-16LE streaming scanner
    formats/
      jpeg/    index.ts segments.ts exif.ts mpf.ts trailer.ts spoof.ts
      png/     index.ts chunks.ts
      webp/    index.ts riff.ts
      isobmff/ index.ts boxes.ts udta.ts times.ts
      ooxml/   index.ts parts.ts rsid.ts
      pdf/     index.ts
      zip/     index.ts
      unknown/ index.ts
    worker/  worker.ts  client.ts
  lib/channels/channels.json   measured, date-stamped platform behaviour
  fixtures/                    one committed real file per format
  scripts/check-bundle.mjs     fails build if parsers leak into marketing chunks
```

---

## 3. The core abstraction

**Never rebuild a file. Emit a patch plan over byte ranges.**

Every library available here writes by rebuilding a buffer — piexifjs a binary string, JSZip the
archive, pdf-lib the object graph, mp4box.js the box tree. Four rebuild semantics, four
corruption modes. One writer instead:

```ts
// lib/metadata/types.ts
export type ByteRange = { readonly start: number; readonly end: number };  // [start, end)
export type Tier = 1 | 2 | 3;

export interface Finding {
  readonly id: string;                  // 'exif.gps', 'jpeg.mpf', 'ooxml.rsid'
  readonly label: string;
  readonly value: string;
  readonly group: 'identity' | 'location' | 'device' | 'time' | 'software'
                | 'history' | 'remnant';
  readonly severity: 'critical' | 'notable' | 'benign';
  readonly range?: ByteRange;
}

export interface EmbeddedAsset {           // the remnant layer
  readonly kind: 'thumbnail' | 'second-image' | 'trailer-video' | 'doc-thumbnail';
  readonly mime: string;
  readonly range: ByteRange;
  readonly note: string;
}

export interface Report {
  readonly format: FormatId;
  readonly tier: Tier;
  readonly findings: readonly Finding[];
  readonly assets: readonly EmbeddedAsset[];
  readonly unhandled: readonly string[];   // what this handler KNOWS it did not inspect
}
```

```ts
// lib/metadata/patch.ts
export type Patch =
  | { readonly kind: 'drop';    readonly range: ByteRange }
  | { readonly kind: 'replace'; readonly range: ByteRange; readonly bytes: Uint8Array };

export interface EditPlan { readonly patches: readonly Patch[]; readonly sizeDelta: number }

/** The only writer in the system. Never materialises the file. */
export function assemble(source: Blob, plan: EditPlan): Blob;
export function validatePlan(plan: EditPlan, sourceSize: number): void;  // throws on overlap/OOB

/** Honest escape hatch for containers that genuinely cannot be patched. */
export type Edit =
  | { readonly kind: 'patch';   readonly plan: EditPlan }
  | { readonly kind: 'rebuild'; readonly build: () => Promise<Blob>; readonly why: string };
```

`assemble` is `new Blob([src.slice(a,b), patchBytes, src.slice(c,d), …])`. `Blob.slice()` is
disk-backed and copies nothing, so peak memory is the size of the patches — kilobytes — not the
size of the file. A 200 MB video costs nothing.

```ts
// lib/metadata/handler.ts
export interface FormatHandler {
  readonly id: FormatId;
  readonly label: string;
  sniff(head: Uint8Array, filename: string): boolean;        // pure, sync, first 4 KB
  inspect(src: Reader): Promise<Report>;
  plan?(src: Reader, report: Report, opts: StripOptions): Promise<Edit>;   // absent ⇒ Tier 3
  spoof?(src: Reader, report: Report, p: SpoofProfile): Promise<Edit>;     // absent ⇒ Tier 2
}
```

Tier is **derived** from which optional methods exist, never declared. A handler cannot claim
Tier 1 without a working spoof path. Adding a format touches exactly two files: a new directory
under `formats/`, and one line in `registry.ts`.

---

## 4. Per-format notes

### 4.1 JPEG — the priority format, and the demo

Walk the marker chain from `FFD8` (SOI). Each segment is `FF <marker> <len:2 BE>` where `len`
includes its own two bytes. **Whitelist, never blacklist:**

| Keep | Drop |
|---|---|
| `FFDB` DQT, `FFC4` DHT, `FFC0–FFCF` SOF (not C4/C8/CC), `FFDD` DRI, `FFDA` SOS + entropy data | Every `FFE0–FFEF` APPn, `FFFE` COM |

After SOS, entropy-coded data runs until a marker that is not a stuffed `FF00` and not an RST
(`FFD0–FFD7`). Truncate the output at `FFD9` (EOI).

`piexif.remove()` only removes the Exif APP1. It leaves XMP (a *second* APP1 with the
`http://ns.adobe.com/xap/1.0/` namespace, which routinely duplicates GPS), APP2 ICC, APP13
IPTC/Photoshop IRB, APP14 Adobe, and COM. Use it for the **spoof insert path only**, fed
already-stripped bytes.

**Two remnant sources — this is the differentiator:**

- **APP2 MPF** (`MPF\0` identifier). Contains an MP Index IFD listing embedded images with
  offset and size, offsets relative to the start of the MPF header. On many Samsung and Apple
  devices this is a *second full-resolution image* — the other lens, or the HDR companion.
  Parse the index, expose each as an `EmbeddedAsset`, render it beside the visible image.
- **Trailing bytes after `FFD9`.** Samsung Motion Photo appends a complete MP4 of the seconds
  around the shot. Sniff the trailer, report its size and type, and offer it for extraction.
  "Your photo contains a video you didn't know about" is a stronger reveal than the 160×120
  thumbnail and far less trodden.

Keep IFD1 thumbnail extraction as the secondary beat — render it **beside** the visible image as
a mismatch diff, never as a raw dump. `exiftool -b -ThumbnailImage` and dCode have dumped
thumbnails for twenty years; the side-by-side verdict is the part that is ours.

### 4.2 PNG

8-byte signature, then `length:4 BE | type:4 | data | crc:4`. Drop ancillary chunks — `tEXt`,
`zTXt`, `iTXt`, `eXIf`, `tIME`, and `iCCP` behind a "keep colour profile" toggle. Critical
chunks have an uppercase first letter (`IHDR`, `PLTE`, `IDAT`, `IEND`) and always stay.
**Deleting whole chunks leaves every surviving CRC valid** — no CRC32 implementation needed.

### 4.3 WebP

`RIFF | size:4 LE | WEBP`, then chunks of `fourcc:4 | size:4 LE | data | pad to even`. Drop
`EXIF` and `XMP `. Then **clear the matching flag bit in the `VP8X` chunk's first data byte** —
ICC `0x20`, alpha `0x10`, EXIF `0x08`, XMP `0x04` — and fix the outer RIFF size field. Skip the
flag fixup and strict decoders reject the file. Write this on the first pass, not as a later bug.

### 4.4 ISOBMFF (MP4 / MOV / HEIC / AVIF) — one handler

Do **not** delete boxes. Deleting anything before `mdat` shifts every chunk offset and forces
`stco`/`co64` patching, whose failure mode is a file that plays in Chrome and fails in QuickTime.

Instead: **overwrite the box in place with a `free` box of exactly the same byte length, payload
zeroed.** ISO/IEC 14496-12 §8.1.2 makes free-space boxes legal anywhere with ignorable contents,
so every parent size and every chunk offset stays correct. Zero size delta, no remux, constant
time on a 200 MB file.

```ts
export const neutralise = (b: Box): Patch =>
  ({ kind: 'replace', range: { start: b.start, end: b.end }, bytes: freeBox(b.end - b.start) });
```

Targets: `moov/udta` (including `©xyz` GPS in ISO-6709), `meta`, the `mdta` keys namespace
(`com.apple.quicktime.location.ISO6709`, `.model`, `.software`), and `uuid` boxes carrying XMP.
`mvhd`/`tkhd`/`mdhd` creation and modification times are fixed-width fields (1904 epoch) —
overwrite in place.

**The UI must say "neutralised", not "deleted".** The bytes are still there, zeroed. Claiming
deletion would be the exact dishonesty this tool exists to expose.

**HEIC stays Tier 3** (read-only, labelled). Apple stores depth maps and Live Photo companions
as separate `iloc` items; a naive rewrite leaves the originals in `mdat`. Detect it, read it with
exifr, and say so.

### 4.5 OOXML (DOCX / XLSX / PPTX)

Deleting `docProps/core.xml` and `app.xml` removes the *least* sensitive third and leaves the
file structurally invalid. Full part list to handle:

| Part | What it leaks |
|---|---|
| `docProps/core.xml` | author, `lastModifiedBy`, revision count |
| `docProps/app.xml` | template path, total edit time |
| `docProps/custom.xml` | custom properties, tenant sensitivity-label GUIDs |
| `docProps/thumbnail.jpeg` | **a rendered image of page one** — remnant layer |
| `word/settings.xml` | `w:rsid*` session fingerprints, `w:attachedTemplate` UNC paths |
| `word/comments.xml`, `people.xml` | commenter names and provider IDs |
| `document.xml` `w:ins`/`w:del` | tracked changes still carrying deleted text |
| `xl/pivotCacheRecords*.xml` | **the full source dataset, including deleted rows** |
| `xl/printerSettings*.bin` | printer name and queue path |
| `media/*` | every embedded image with its own intact EXIF — recurse the stripper |

Removing a part **requires** also removing its `Override` in `[Content_Types].xml` and its
`Relationship` in `_rels/.rels`, or Word declares the file corrupt. Set every entry's date
explicitly (`zip.file(name, data, { date: new Date(0) })`) — JSZip defaults to `new Date()` and
re-leaks the moment of cleaning.

**APK and JAR are Tier 3, detect-only.** Re-zipping invalidates the v1 `META-INF` digests and
drops the v2/v3 APK Signing Block, which JSZip does not model — the output is uninstallable.
EPUB needs `mimetype` first and STORED, or it will not open.

### 4.6 PDF

Do **not** use `load()` / `save()` — pdf-lib's parser walks indirect objects out of the file, so
objects superseded by earlier revisions can be re-emitted. Use the copy path, which walks only
the reachable page tree:

```ts
const out = await PDFDocument.create();
const pages = await out.copyPages(src, src.getPageIndices());
pages.forEach(p => out.addPage(p));
```

Then explicitly delete `/Metadata` (the XMP stream) and `/PieceInfo` from the catalog and each
page, clear annotation `/T` author fields, set all six Info fields, and overwrite
`context.trailerInfo.ID`. Note pdf-lib stamps its own `/Producer` — set it deliberately.
Reject encrypted PDFs rather than emitting a broken file.

**Verify with a PDF edited twice, then grep the output for the removed string.** That grep is
also a good demo.

### 4.7 Unknown binaries — Tier 3

Stream 8 MB chunks with a **1 KB overlap** (a string straddling a boundary is otherwise missed)
and run two passes per chunk: latin1, and UTF-16LE. Windows binaries store paths as UTF-16LE, so
`C:\Users\` is `43 00 3A 00 5C 00 …` and never matches an ASCII pattern — an ASCII-only scan
reports "clean" on a file that leaks the username. Patterns: absolute paths, emails, hostnames,
URLs, GUIDs.

This tier **must refuse to claim it cleaned anything**. Report findings, offer extraction, state
plainly that the file was not rewritten. mat2 takes the same stance in its own man page; credit
it rather than presenting the norm as ours. Lineage for the technique is `bulk_extractor`
(Garfinkel).

---

## 5. Build order

Cut from the bottom. Every prefix is a coherent, demoable submission.

| # | Item | h | Owner |
|---|---|---|---|
| 0 | Scaffold, drop zone, Reader + patch engine, worker | 2.5 | both |
| 1 | JPEG: marker walk, full read, **MPF + trailer reveal**, lossless strip | 7 | Rayyan |
| 2 | Three-layer + remnant honesty panel | 1 | Moinuddin |
| 3 | Channel router with measured data (§7) | 3 | Moinuddin |
| — | **24 h line** | | |
| 4 | Adversarial verify — point it at a rival tool's output | 2 | Rayyan |
| 5 | PNG + WebP strip (incl. VP8X flag fixup) | 2.5 | Rayyan |
| 6 | OOXML with container repair + named unhandled list | 3 | Moinuddin |
| — | **36 h line** | | |
| 7 | Unknown-binary scan, both encodings | 2 | Rayyan |
| 8 | ISOBMFF free-box neutralise | 3 | Rayyan |
| 9 | PDF via copyPages | 3 | Moinuddin |
| — | **Cut:** hosted sharing, HEIC/TIFF writers, self-host Docker, spoof beyond JPEG | | |

---

## 6. The verification pass — non-negotiable

A tool that writes a file and asserts it is clean without re-reading what it produced cannot be
trusted, and the entire product rests on that assertion.

```ts
const out = assemble(source, plan);
const check = await handler.inspect(readerOf(out));
const survived = check.findings.filter(f => f.severity !== 'benign');
// survived.length > 0  →  UI says "partially cleaned — N items remain". Never "clean".
```

Additionally byte-scan the output for every sensitive literal found in the input — GPS decimals
as text, usernames, machine names, camera model, original filename. Run this **in the app**, not
only in tests, and show it as a green check.

**The fixture task, hour one:** hand-build a JPEG carrying an MPF second image and an IFD1
thumbnail that differs from the visible frame, verify it round-trips, commit it to `fixtures/`.
If this cannot be manufactured, the demo does not exist — reshape the pitch immediately.

---

## 7. Channel router — measure, do not assert

Platform behaviour is undocumented, version-dependent, and changes silently. Shipping an
unverified table inside a security tool is misinformation with a privacy consequence.

**Method.** One test image with known GPS, known camera serial, and a known MPF second image.
Send it through every channel in every mode. Download the result. Re-read it with our own
engine. Record what survived.

Channels to measure: WhatsApp (photo / HD photo / document), Telegram (photo / file), Instagram
post, Gmail attachment, Google Drive link, Signal, Discord, iMessage.

Every row in `channels.json` carries `verifiedOn`, `appVersion`, `os`. Rows not yet measured
render as **"unverified — do not rely on this"**. Ship a one-click "test this yourself" flow;
that turns the weakest feature into the most verifiable one.

Known published baseline to check our numbers against, not to copy: MetaClean (Jan 2025) reports
100% of WhatsApp document-mode transfers preserve all EXIF, ~89% GPS removal in compressed photo
mode, and 23% retention at original quality. **The defensible line is that platform stripping is
probabilistic** — 89% is not 100%, so it cannot be relied on. IPTC has published a static
comparison at embeddedmetadata.org since 2013; cite it, do not reinvent it.

---

## 8. The privacy claim, enforced

Route-scoped header on `/tool`, so exfiltration is a browser-enforced impossibility rather than
a promise:

```
Content-Security-Policy: default-src 'self'; connect-src 'none';
  script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' data: blob:
```

Notes that cost time if missed:

- `worker-src 'self'` **blocks blob-URL workers**, the common Emscripten bootstrap. Use
  same-origin worker files. (The portfolio's `public/py-worker.js` boots a 3.4 MB Pyodide WASM
  module in production under exactly this policy — the pattern works, copy it.)
- No analytics, no error reporting, no third-party script anywhere on that route. Sentry's
  default `request.url` is `window.location.href`; GA4's `page_location` retains the hash.
- `URL.revokeObjectURL` immediately after download — object URLs stay same-origin-readable for
  the document's lifetime otherwise.
- Never `canvas.toBlob()` as a strip shortcut. It removes metadata *and* re-encodes the pixels,
  which makes "we don't touch your image data" false and stamps the browser's own encoder
  fingerprint on the output. If out of time for a format, ship read-only instead.

Demo it: open the Network tab, drop a file, show that nothing goes out.

---

## 9. Testing and gates

- **Vitest** over `fixtures/` — one real file per format. Assert: output parses, findings empty
  after strip, pixel data byte-identical, file opens in its native application.
- `scripts/check-bundle.mjs` — fail the build if `pdf-lib`, `jszip` or `exifr` appears in any
  chunk reachable from the marketing route. The engine is a `next/dynamic` client-only import
  behind an explicit "load the engine" state.
- Test at **exactly 360 px** with device emulation. A `scrollWidth` check cannot see a mobile
  layout bug — the browser zooms out and the page measures clean.

---

## 10. Demo script — five minutes

| Time | Beat |
|---|---|
| 0:30 | Concede the commodity. "Stripping is solved. Your phone already removes GPS. Here is what nobody does." |
| 1:30 | Drop a phone photo. GPS as a map pin, camera serial, timestamp — **then the MPF second image and the appended video** rendered beside it. |
| 1:00 | Clean it. Drag the output back in. Zero findings, byte sizes before and after, pixels untouched. |
| 0:45 | Three-layer panel. Layer 2 — upload IP, account binding — we cannot touch, and we say so. |
| 0:45 | Channel router. WhatsApp photo vs document, with our own measured numbers and the date. |
| 0:30 | Network tab open. Nothing left the browser, and the CSP is why. |

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| The demo fixture cannot be manufactured | Build it hour one, before product code |
| A parser silently under-reports and we call a file clean | Verification pass is mandatory; `unhandled[]` is always rendered |
| Scope creep back toward hosted sharing | It is cut. Wormhole and Bitwarden Send already exist; an open file host on a personal domain risks Safe Browsing flagging it |
| Channel data is wrong on stage | Every row date-stamped; unmeasured rows say "unverified" |
| Next 16 API drift | Read `node_modules/next/dist/docs/` before writing route code |
