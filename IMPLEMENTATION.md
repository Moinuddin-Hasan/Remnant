# Remnant — Implementation Plan

Hackulus 2026 · Cybersecurity Option 3 · Syed Rayyan Azeez (lead), Moinuddin Hasan

Three modes over one format engine: **Inspect & Clean**, **Forge**, **Share**.

---

## 0. Open questions

| Question | Blocks | Status |
|---|---|---|
| Does Hackulus permit pre-existing code? | Everything — we already have a working engine committed | **Unconfirmed** |
| Which domain hosts the Share service? | Phase 3 | **Unconfirmed** |
| Total build hours; is judging inside the clock? | Cut line | Unconfirmed |
| Is the channel router in or out? | Phase 2 scope | See §8 |

---

## 1. What the tool does

**Inspect & Clean.** Read a file, name everything it discloses with byte ranges, surface the
embedded payload nothing renders, strip it losslessly, then re-read the output and report what
actually came out.

**Forge.** Take a clean file and write a new identity onto it — make, model, capture time, GPS,
software, artist — then score the result for internal contradictions.

**Share.** Encrypt in the browser, upload ciphertext, hand out a link whose fragment carries the
key. TTL, download cap, burn on claim. Self-hostable.

The three are the same engine pointed in different directions. A file is parsed into byte ranges
once; reading, rewriting and forging all operate on that representation.

---

## 2. Repository layout

Separate Vercel project on a subdomain. **Not** inside the portfolio tree — that has 13 build
gates, a strict production CSP, 16 undeployed commits, and a deploy script that goes straight to
production.

```
remnant/
  app/
    page.tsx                    landing
    tool/page.tsx               inspect + clean        [BUILT]
    forge/page.tsx              forge pipeline         [phase 2]
    s/[id]/page.tsx             share claim + decrypt  [phase 3]
    api/share/token/route.ts    presigned upload       [phase 3]
    api/share/[id]/route.ts     gated download + burn  [phase 3]
  components/tool/              Engine, DropZone, FindingList,
                                RemnantReveal, VerifyPanel          [BUILT]
  components/forge/             ProfileForm, LintPanel, ForgeReport [phase 2]
  components/share/             ShareForm, ClaimGate                [phase 3]
  lib/metadata/
    types.ts reader.ts patch.ts registry.ts handler.ts pipeline.ts  [BUILT]
    scan/strings.ts                                                 [BUILT]
    formats/jpeg/   index segments mpf trailer                      [BUILT]
    formats/jpeg/   exif-write.ts                                   [phase 2]
    formats/unknown/                                                [BUILT]
    formats/png|webp|isobmff|ooxml|pdf|zip/                         [phase 4]
    worker/ worker.ts client.ts                                     [BUILT]
  lib/forge/        profile.ts lint.ts rules.ts data/models.json    [phase 2]
  lib/share/        crypto.ts client.ts store.ts                    [phase 3]
  fixtures/build.ts                                                 [BUILT]
  docker/           Dockerfile compose.yml                          [phase 3]
```

---

## 3. The core abstraction — built

**Never rebuild a file. Emit a patch plan over byte ranges.**

Every library available here writes by rebuilding a buffer — piexifjs a binary string, JSZip the
archive, pdf-lib the object graph, mp4box.js the box tree. Four rebuild semantics, four
corruption modes. One writer instead:

```ts
export type Patch =
  | { readonly kind: "drop";    readonly range: ByteRange }
  | { readonly kind: "replace"; readonly range: ByteRange; readonly bytes: Uint8Array };

export function assemble(source: Blob, plan: EditPlan, type?: string): Blob;
export function validatePlan(plan: EditPlan, sourceSize: number): void;
```

`assemble` is `new Blob([src.slice(a,b), patchBytes, src.slice(c,d), …])`. `Blob.slice()` is
disk-backed and copies nothing, so peak memory is the size of the patches — kilobytes — not the
size of the file. A 200 MB video costs nothing, and the bytes we do not touch are bit-identical
by construction. That is what lets us say the pixels are untouched, and there is a test asserting
the entropy-coded scan is byte-for-byte equal before and after.

**The same engine writes forged data.** Forge builds a TIFF/EXIF block and splices it in as a
`replace` patch. No second write path, no second corruption mode.

```ts
export interface FormatHandler {
  readonly id: FormatId;
  sniff(head: Uint8Array, filename: string): boolean;   // pure, sync, first 4 KB
  inspect(src: Reader): Promise<Report>;
  plan?(src, report, opts): Promise<Edit>;              // absent ⇒ Tier 3, no Clean button
  spoof?(src, report, profile): Promise<Edit>;          // absent ⇒ Tier 2, no Forge
}
```

Tier is **derived** from which methods exist, never declared, so a handler cannot advertise a
capability it has not implemented. Adding a format touches two files: a directory under
`formats/`, and one line in `registry.ts`.

---

## 4. Per-format notes

### 4.1 JPEG — built

Walk the marker chain from `FFD8`. Each segment is `FF <marker> <len:2 BE>` where `len` includes
its own two bytes. **Whitelist, never blacklist:**

| Keep | Drop |
|---|---|
| `FFDB` DQT, `FFC4` DHT, `FFC0–FFCF` SOF (not C4/C8/CC), `FFDD` DRI, `FFDA` SOS + entropy | Every `FFE0–FFEF` APPn, `FFFE` COM |

After SOS, entropy data runs until a marker that is neither stuffing (`FF00`) nor a restart
(`FFD0–FFD7`). Truncate output at `FFD9`.

`piexif.remove()` only removes the Exif APP1 — it leaves XMP (a *second* APP1 with the
`ns.adobe.com/xap` namespace, which routinely duplicates GPS), APP2 ICC, APP13 IPTC, APP14 Adobe
and COM. That is why the strip is a whitelist. piexifjs is used only on the **write** path.

**Two remnant sources, both working:**

- **APP2 MPF** (`MPF\0` identifier) — an MP Index IFD listing embedded images by offset and size,
  offsets relative to the MPF TIFF header. On Samsung and Apple devices this is a *second
  full-resolution image*. Survives every EXIF-only strip.
- **Bytes after `FFD9`** — Samsung Motion Photo appends a complete MP4 of the seconds around the
  shot, audio included.

⚠ These overlap: MPF images live after the primary EOI too. The trailer is reported **net of
MPF-declared ranges**, or the same bytes get counted twice. This was a real bug the fixture caught.

### 4.2 PNG — phase 4

`length:4 BE | type:4 | data | crc:4`. Drop `tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME`, and `iCCP`
behind a toggle. Critical chunks (uppercase first letter) always stay. Deleting whole chunks
leaves every surviving CRC valid — no CRC32 implementation needed.

### 4.3 WebP — phase 4

`RIFF | size:4 LE | WEBP`, then `fourcc:4 | size:4 LE | data | pad to even`. Drop `EXIF` and
`XMP `. Then **clear the matching flag bit in `VP8X`'s first data byte** — ICC `0x20`, alpha
`0x10`, EXIF `0x08`, XMP `0x04` — and fix the outer RIFF size. Skip the flag fixup and strict
decoders reject the file.

### 4.4 ISOBMFF (MP4/MOV/HEIC/AVIF) — phase 4

Do **not** delete boxes. Anything removed before `mdat` shifts every chunk offset and forces
`stco`/`co64` patching, whose failure mode is a file that plays in Chrome and fails in QuickTime.

Instead overwrite the box in place with a **`free` box of exactly the same byte length, payload
zeroed**. ISO/IEC 14496-12 §8.1.2 makes free-space boxes legal anywhere with ignorable contents,
so every parent size and chunk offset stays correct. Zero size delta, no remux, constant time.

Targets: `moov/udta` (incl. `©xyz` GPS), `meta`, the `mdta` keys namespace
(`com.apple.quicktime.location.ISO6709`, `.model`, `.software`), `uuid` boxes carrying XMP.
`mvhd`/`tkhd`/`mdhd` times are fixed-width (1904 epoch) — overwrite in place.

UI says **neutralised**, not deleted: the bytes remain, zeroed.

HEIC stays read-only. Apple stores depth maps and Live Photo companions as separate `iloc` items;
a naive rewrite leaves originals in `mdat`.

### 4.5 OOXML — phase 4

Deleting `docProps/core.xml` and `app.xml` removes the *least* sensitive third and leaves the file
structurally invalid.

| Part | Leaks |
|---|---|
| `docProps/custom.xml` | custom properties, tenant sensitivity-label GUIDs |
| `docProps/thumbnail.jpeg` | **a rendered image of page one** |
| `word/settings.xml` | `w:rsid*` session fingerprints, `w:attachedTemplate` UNC paths |
| `comments.xml`, `people.xml` | commenter names and provider IDs |
| `document.xml` `w:ins`/`w:del` | tracked changes still carrying deleted text |
| `xl/pivotCacheRecords*.xml` | **the full source dataset, including deleted rows** |
| `xl/printerSettings*.bin` | printer name and queue path |
| `media/*` | embedded images with intact EXIF — recurse the stripper |

Removing a part **requires** also removing its `Override` in `[Content_Types].xml` and its
`Relationship` in `_rels/.rels`, or Word calls the file corrupt. Set every entry date explicitly
(`{ date: new Date(0) }`) — JSZip defaults to `new Date()` and re-leaks the moment of cleaning.

APK/JAR are detect-only: re-zipping invalidates v1 `META-INF` digests and drops the v2/v3 Signing
Block. EPUB needs `mimetype` first and STORED.

### 4.6 PDF — phase 4

Do **not** use `load()`/`save()` — pdf-lib's parser walks indirect objects out of the file, so
superseded revisions can be re-emitted. Use the copy path, which walks only the reachable page
tree:

```ts
const out = await PDFDocument.create();
const pages = await out.copyPages(src, src.getPageIndices());
pages.forEach(p => out.addPage(p));
```

Then delete `/Metadata` and `/PieceInfo` from the catalog and each page, clear annotation `/T`,
set all six Info fields, and overwrite `trailerInfo.ID`. pdf-lib stamps its own `/Producer` — set
it deliberately. Reject encrypted PDFs rather than emitting a broken file.

### 4.7 Unknown binaries — built

Stream 8 MB chunks with a **1 KB overlap** and run two passes: latin1 and UTF-16LE. Windows
binaries store paths as UTF-16LE, so `C:\Users\` is `43 00 3A 00 5C 00 …` and an ASCII-only scan
misses it entirely. Patterns: absolute paths, emails, hostnames, URLs, GUIDs.

Ships no `plan`, so it is Tier 3 and the UI cannot offer a Clean button for it. We do not rewrite
containers we cannot parse — a broken file is a worse outcome than a leaky one.

---

## 5. Forge pipeline — phase 2

```
clean file → profile form → build TIFF/EXIF → splice as a patch → lint → download
```

**Writer** (`formats/jpeg/exif-write.ts`). Build an APP1 segment — `Exif\0\0` then a TIFF header,
IFD0 with Make/Model/Software/Artist/DateTime, a GPS IFD pointer, and the GPS IFD with
lat/lon ref + rationals. `fixtures/build.ts` already contains a working EXIF builder; lift it.
Splice as `replace` over the existing APP1 range, or insert after SOI when none exists.

**Profile** (`lib/forge/profile.ts`): make, model, software, artist, `DateTimeOriginal`, timezone
offset, latitude, longitude.

**Linter** (`lib/forge/lint.ts`) — this is the actual engineering. Writing EXIF is trivial;
writing EXIF that does not contradict itself is not. Rules:

| Rule | Contradiction |
|---|---|
| `make.vs.makernote` | `Make=Apple` with a Nikon MakerNote still present |
| `gps.vs.tz` | GPS longitude implies a UTC offset far from `OffsetTimeOriginal` |
| `date.vs.model` | capture date precedes the model's release date |
| `software.vs.make` | editor string inconsistent with the claimed device |
| `dimensions.vs.model` | sensor resolution the claimed body never shipped |
| `self` | our own writer's structural signature (IFD ordering, padding) |

Needs a hand-built `data/models.json` of roughly 40 devices with release dates and native
resolutions. Say "checked against 40 known models", not "verified".

```ts
export function lint(report: Report, profile?: SpoofProfile): LintResult;
```

One function, two directions: pass a profile to grade a forgery you are creating, omit it to
analyse a file someone sent you.

⚠ **Accuracy constraint, not an ethics one:** never write "undetectable" in the UI. Quantization
and Huffman tables, chroma subsampling, double-compression DCT artifacts, CFA demosaicing traces,
lens distortion and PRNU all survive metadata forgery. "Consistent" is defensible; "undetectable"
is false and a judge who knows the field will open the whole project up on it.

---

## 6. Share pipeline — phase 3

```
encrypt in browser → request token → PUT ciphertext → link with #key → claim → burn
```

**Crypto** (`lib/share/crypto.ts`):

- `crypto.subtle.generateKey({ name: "AES-GCM", length: 256 })`
- 12-byte IV from `crypto.getRandomValues`
- Plaintext is `JSON header || file bytes`, so **filename and MIME live inside the ciphertext** —
  otherwise the operator learns "resume.pdf, 412,882 bytes" without decrypting anything
- Pad to the next 1 MB bucket before encrypting, or ciphertext length fingerprints the file
- Bind the file id into `additionalData` so ciphertext cannot be moved between ids
- ≤25 MB encrypts in one `subtle.encrypt` call. If chunking is ever added, use STREAM
  (7-byte random prefix ‖ 4-byte counter ‖ 1-byte final flag) — a reused GCM nonce leaks the
  auth subkey, and unbound chunk indices allow silent truncation

**Upload.** `POST /api/share/token` with `{ paddedSize }` and nothing else — no name, no type, no
hash. Returns `{ id, uploadUrl, expiresAt }`. Browser PUTs ciphertext as
`application/octet-stream`. The function never touches file bytes, which also sidesteps Vercel's
4.5 MB request cap.

**Link.** `/s/<id>#<base64url(key)>.<base64url(iv)>`. Browsers never put a fragment in an HTTP
request, so the server stores ciphertext it has no key for.

**Claim and burn.** `/s/<id>` renders a gate; bytes are served only from an explicit click, never
a GET reachable by navigation or prefetch. Set `prefetch={false}` on any `next/link` into it —
Next prefetches on hover in production and will consume the read. The counter decrement must be
**atomic** (`DECR` on Upstash, or `UPDATE … WHERE remaining > 0 RETURNING`); a read-then-write on
serverless is a TOCTOU race and a crawler plus a human within the same second is the expected
case, not the pathological one.

Burn on **claim**, not on bytes delivered: the click consumes the counter and mints a 60–120 s
single-use URL that may be ranged and retried. At-most-once delivery over an unreliable channel
is not achievable — this is the Two Generals problem, not an implementation gap.

**Controls:** 25 MB cap pinned in the presign policy (a client-side size check is bypassable by
calling the token endpoint directly), ≥128-bit random ids so the store is not enumerable,
rate-limit counters in shared KV keyed on IP and on a global bucket, `Cache-Control: no-store`,
`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and never serve uploaded
bytes inline from an origin that holds anything else.

**Self-host** (`docker/`). Same service, filesystem backend instead of blob storage, no account
system. ⚠ `crypto.subtle` is unavailable outside a secure context, so a self-hosted instance on a
plain-http LAN IP has no crypto at all — detect `!window.isSecureContext` and refuse with a clear
message rather than failing silently.

---

## 7. Verification — built, and non-negotiable

Every library in the stack silently preserves or adds something: `piexif.remove()` strips only
APP1; `pdf-lib` writes its own `/Producer`; JSZip stamps entries with `new Date()`. A writer-only
pipeline never observes any of it.

```ts
const out = assemble(file, plan);
const after = await handler.inspect(readerOf(out));
const survived = after.findings.filter(f => f.severity !== "benign");
const literalsFound = await findLiterals(out, sensitiveLiterals(before));
// anything non-empty → "partially cleaned — N remain", never "clean"
```

Re-parsing is necessary but not sufficient: a parser only looks where it knows to look. The
literal scan catches data surviving somewhere the parser does not inspect. This runs **in the
app**, not only in tests, and its result is what the UI prints. An operator will not keep using a
tool that tells them a file is clean when it is not.

---

## 8. Channel router — decision needed

Built for the earlier scope, cut from the Review 0 deck when Share replaced it. The organisers'
statement explicitly includes *"the way files are transferred or uploaded"*, and Share answers
that by doing rather than advising — so this is optional, not required.

If it ships: measure every row ourselves. One test image with known GPS, known serial and a known
MPF second image, sent through WhatsApp (photo / HD / document), Telegram (photo / file),
Instagram, Gmail, Drive, Signal, Discord, iMessage. Download, re-read with our own engine, record
what survived. Every row carries `verifiedOn`, `appVersion`, `os`; unmeasured rows render as
unverified. Platform behaviour is undocumented and version-dependent — an unverified table inside
a security tool is misinformation.

Published baseline to check against, not copy: MetaClean (Jan 2025) reports 100% of WhatsApp
document-mode transfers preserve all EXIF, ~89% GPS removal in compressed photo mode, 23%
retention at original quality. IPTC has published a static comparison since 2013.

---

## 9. Build order

| Phase | Item | Status |
|---|---|---|
| **1** | Scaffold, Reader, patch engine, worker, JPEG read/strip, MPF + trailer reveal, verification, Tier 3 scan | ✅ **built, 9 tests green** |
| **2** | EXIF writer, profile form, GPS IFD builder, linter + `models.json`, forge report | next |
| **3** | WebCrypto, presigned upload, fragment link, TTL/cap/burn, claim gate, Docker self-host | after 2 |
| **4** | PNG, WebP, OOXML, PDF, ISOBMFF | as time allows |

---

## 10. Gates

- **Vitest** over `fixtures/` — output parses, findings empty after strip, entropy scan
  byte-identical, file opens in its native application.
- `connect-src 'none'` on `/tool` and `/forge` makes exfiltration browser-enforced rather than
  promised. `/s/[id]` needs `connect-src 'self'` for the claim fetch, and **no third-party script
  anywhere near it** — Sentry's default `request.url` is `window.location.href` and GA4's
  `page_location` retains the hash, either of which ships the key to a third party.
- `worker-src 'self'` blocks blob-URL workers; workers must be same-origin files.
- Never `canvas.toBlob()` as a strip shortcut — it re-encodes pixels, which makes the lossless
  claim false and stamps the browser's own encoder fingerprint on the output.
- `URL.revokeObjectURL` after download; object URLs stay same-origin-readable otherwise.
- Test at exactly 360 px with device emulation. A `scrollWidth` check cannot see a mobile layout
  bug — the browser zooms out and the page measures clean.
- Bundle assertion: fail the build if parser libraries reach any chunk on the landing route.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| A parser under-reports and we call a file clean | Verification pass is mandatory; `unhandled[]` always rendered |
| Share overruns and eats the clock | It is phase 3; phases 1–2 are a complete submission on their own |
| Share domain gets flagged by Safe Browsing | Open resolution — see §0. Not the portfolio apex |
| Forge is challenged on ethics at judging | Lead with the linter as a detector; never claim undetectable |
| Channel data wrong on stage | Every row date-stamped, unmeasured rows say so |
| Next 16 API drift | Read `node_modules/next/dist/docs/` before writing route code |
