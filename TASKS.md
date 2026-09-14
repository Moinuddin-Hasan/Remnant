# Tasks

Two contributors, working in parallel. **The file ownership table below is the contract** —
stick to it and we never resolve a merge conflict.

- **Rayyan** — new format handlers, fixtures for them, the device table, Docker packaging.
- **Moinuddin** — engine core, forge pipeline, share pipeline, app routes and UI.

Architecture and per-format technical notes live in `IMPLEMENTATION.md`. The current version
is on branch `engine/jpeg-core` (PR #1); `main`'s copy is stale until that merges.

---

## Ground rules

**Branch per task. Never push to `main`.** The repo already has a merge-of-main-into-main from
its first ten minutes; two people on `main` during a hackathon will lose work. Name branches
`format/png`, `format/webp`, `docker/package`, and so on. Open a PR, let the other person read
it, merge from the PR page.

**Before you push:** `npm run typecheck && npm test && npm run build`. All three, every time.
A handler that breaks the build blocks the other person completely.

**Never edit a file you do not own.** If you need a change in someone else's file, say so and
they will make it.

---

## File ownership

| Path | Owner |
|---|---|
| `lib/metadata/types.ts` `reader.ts` `patch.ts` `handler.ts` `pipeline.ts` | Moinuddin |
| `lib/metadata/scan/` `lib/metadata/worker/` | Moinuddin |
| `lib/metadata/formats/jpeg/` `formats/unknown/` | Moinuddin |
| `lib/forge/` (except `data/models.json`) | Moinuddin |
| `lib/share/` | Moinuddin |
| `app/` `components/` | Moinuddin |
| `fixtures/build.ts` | Moinuddin |
| `lib/metadata/engine.test.ts` | Moinuddin |
| **`lib/metadata/formats/png/`** | **Rayyan** |
| **`lib/metadata/formats/webp/`** | **Rayyan** |
| **`lib/metadata/formats/isobmff/`** | **Rayyan** |
| **`fixtures/png.ts` `fixtures/webp.ts` `fixtures/isobmff.ts`** | **Rayyan** |
| **`lib/forge/data/models.json`** | **Rayyan** |
| **`lib/channels/data/channels.json`** | **Rayyan** |
| `lib/channels/` (everything else) | Moinuddin |
| **`docker/`** `.dockerignore` | **Rayyan** |

### The one shared file

`lib/metadata/registry.ts` — **append only**. Adding a handler is two lines: an import at the
top, and one entry in `HANDLERS` before `unknownHandler`. `unknownHandler` must stay last
because its `sniff` always returns true. Touch nothing else in that file and a conflict there
is a one-line fix.

---

## What you are building against

Every handler implements this. It is already defined in `lib/metadata/handler.ts` — do not
edit that file, just import the type.

```ts
export interface FormatHandler {
  readonly id: FormatId;
  readonly label: string;
  sniff(head: Uint8Array, filename: string): boolean;   // pure, sync, first 4 KB
  inspect(src: Reader): Promise<Report>;
  plan?(src, report, opts): Promise<Edit>;              // omit ⇒ read-only, no Clean button
  spoof?(src, report, profile): Promise<Edit>;          // omit ⇒ no Forge
}
```

### ⚠ Handlers now need `spoof` as well as `plan`

Forge is a first-class mode and must work on every format we can write, not just JPEG. PNG and
WebP ship **both** `plan` (strip) and `spoof` (write a forged identity).

`spoof` takes a `SpoofProfile` — make, model, dateTime, offsetTime, latitude, longitude,
software, artist — and returns an `Edit` exactly like `plan`. Build the metadata block, splice
it over the existing one, and drop every *other* metadata segment while you are there. Leaving
an old text chunk naming the real camera beside a forged block is the most obvious
contradiction a file can carry, and our own linter will flag it.

- **PNG**: write an `eXIf` chunk (payload is a bare TIFF block — no `Exif\0\0` prefix) before
  `IDAT`, dropping existing text and EXIF chunks.
- **WebP**: write an `EXIF` RIFF chunk, again a bare TIFF block, and **set** the `0x08` flag bit
  in `VP8X` rather than clearing it. Fix the RIFF size.
- **ISOBMFF**: `inspect` and `plan` only — **no `spoof`**. Writing `udta`/`©xyz` changes box
  sizes, which puts you straight back into the chunk-offset problem the `free`-box trick exists
  to avoid. Omit the method and the UI refuses forging automatically.

⚠ `lib/metadata/formats/jpeg/exif-write.ts` exports **`buildTiff(profile)`**, which builds the
TIFF block both PNG and WebP need. Import it — do not reimplement it. That file is mine and
already tested; calling across is fine, editing it is not.

Three things to internalise before writing a handler:

1. **Read through `Reader`, never `file.arrayBuffer()`.** It is a lazy, ranged, block-cached
   view over a Blob. A 200 MB file costs kilobytes. `src.u8/u16be/u16le/u32be/u32le/bytes/
   ascii/find` are all there.
2. **Never build output yourself.** Return byte ranges to drop or replace and the patch engine
   assembles the file by slicing the original. That is what keeps untouched bytes bit-identical.
3. **Tier is derived, not declared.** No `plan` means the UI automatically refuses to offer a
   clean. If you cannot strip a format safely, ship `inspect` alone — that is a valid result,
   not a failure.

`FormatId` in `types.ts` already includes `"png" | "webp" | "isobmff"`, so no edit is needed
there.

---

## R1 — PNG handler

**Branch** `format/png` · **Files** `lib/metadata/formats/png/` · `fixtures/png.ts`

Structure: an 8-byte signature, then chunks of `length:4 BE | type:4 | data | crc:4`.

- `sniff`: `89 50 4E 47 0D 0A 1A 0A`.
- `inspect`: report every ancillary chunk with its byte range. Decode `tEXt`/`iTXt`/`zTXt`
  keyword and value into findings; surface `eXIf` (yes, PNG carries EXIF) by handing its
  payload to `exifr`.
- `plan`: drop `tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME`. Drop `iCCP` unless
  `opts.keepColorProfile`.

⚠ Critical chunks have an uppercase first letter (`IHDR`, `PLTE`, `IDAT`, `IEND`) and must
always survive. **Deleting a whole chunk leaves every other chunk's CRC valid** — you do not
need a CRC32 implementation, and if you find yourself writing one you have taken a wrong turn.

- `spoof`: write an `eXIf` chunk from `buildTiff(profile)`, placed before `IDAT`.

**Done when:** a PNG with text chunks and an `eXIf` block inspects correctly, strips to zero
findings, the `IDAT` bytes are identical before and after, a forged PNG reads back with the
values that went in, and the output opens in an image viewer.

---

## R2 — WebP handler

**Branch** `format/webp` · **Files** `lib/metadata/formats/webp/` · `fixtures/webp.ts`

Structure: `RIFF | size:4 LE | WEBP`, then chunks of `fourcc:4 | size:4 LE | data | pad to
even`. Note the sizes are **little-endian** here, unlike PNG.

- `sniff`: `RIFF` at 0 and `WEBP` at 8.
- `inspect`: report `EXIF`, `XMP `, `ICCP` with ranges; parse the `EXIF` payload with `exifr`.
- `plan`: drop `EXIF` and `XMP `; drop `ICCP` unless `opts.keepColorProfile`.

⚠ **Two things break the file if you miss them.** Clear the matching flag bit in the `VP8X`
chunk's first data byte — ICC `0x20`, alpha `0x10`, EXIF `0x08`, XMP `0x04` — and fix the outer
RIFF size field at offset 4. Skip either and strict decoders reject the output while Chrome
happily displays it, so test in something other than a browser. Write the flag fixup on the
first pass; it is not a bug to find later.

⚠ Remember the odd-length padding byte when computing ranges.

- `spoof`: write an `EXIF` chunk from `buildTiff(profile)` and **set** the `0x08` `VP8X` flag
  bit, fixing the RIFF size.

**Done when:** a WebP with EXIF and XMP strips clean, `VP8X` flags are correct in both
directions, a forged WebP reads back correctly, and the output passes a strict decoder.

---

## R3 — ISOBMFF handler (MP4 / MOV / HEIC / AVIF)

**Branch** `format/isobmff` · **Files** `lib/metadata/formats/isobmff/` · `fixtures/isobmff.ts`

One handler for all four — same box grammar. Boxes are `size:4 BE | type:4`, with `size == 1`
meaning a 64-bit size follows and `size == 0` meaning "to end of file".

- `sniff`: `ftyp` at offset 4.
- `inspect`: walk the tree. Report `moov/udta` (including `©xyz`, which is GPS in ISO-6709
  format), `meta`, the `mdta` keys namespace — `com.apple.quicktime.location.ISO6709`,
  `.model`, `.software` — `uuid` boxes carrying XMP, and the `creation_time` /
  `modification_time` fields in `mvhd`/`tkhd`/`mdhd` (**1904 epoch**, not 1970).
- `plan`: **do not delete anything.**

⚠ **This is the one that will cost you a night if you do it the obvious way.** Removing bytes
before `mdat` shifts every chunk offset, so you would have to patch every entry in `stco`/`co64`,
and the failure mode is a file that plays in Chrome and fails in QuickTime — you will not notice
until the demo.

Instead: **overwrite the box in place with a `free` box of exactly the same byte length, payload
zeroed.** ISO/IEC 14496-12 §8.1.2 makes free-space boxes legal anywhere and their contents
explicitly ignorable, so every parent size and every chunk offset stays correct. Zero size delta,
no remux, constant time on a 200 MB file.

```ts
const neutralise = (b: Box): Patch =>
  ({ kind: "replace", range: { start: b.start, end: b.end }, bytes: freeBox(b.end - b.start) });
```

Fixed-width time fields are just overwritten in place.

⚠ The UI must say **neutralised**, not deleted — the bytes are still there, zeroed. Put that
wording in the `Report.unhandled` entry so it reaches the screen.

⚠ **HEIC is read-only.** Ship `inspect` with no `plan` for it. Apple stores depth maps and Live
Photo companions as separate `iloc` items, and a naive rewrite leaves the originals sitting in
`mdat`. Detect it, read it, say it is read-only.

**Done when:** an MP4 with a GPS `udta` inspects correctly, neutralises to zero findings, is
byte-identical in length, and **still plays in QuickTime or VLC** — not just Chrome.

---

## R4 — Device table

**Branch** `data/models` · **File** `lib/forge/data/models.json`

Data for the forge linter, which flags a capture date earlier than the claimed camera's release.
Pure data entry — no code, and it does not touch anything I am building.

```json
[
  { "make": "Apple", "model": "iPhone 15 Pro", "released": "2023-09-22",
    "width": 8064, "height": 6048 }
]
```

**A 9-entry seed already exists** so the linter compiles — extend it, do not start over. It is
still your file.

Target roughly 40 entries: recent iPhones, Pixels, Samsung Galaxy S series, and a handful of
Canon, Nikon, Sony and Fujifilm bodies. `model` must match the EXIF `Model` string exactly as
the device writes it — check a real photo or an online EXIF sample rather than guessing,
because a near-miss makes the rule silently never fire.

⚠ **The EXIF string is often not the marketing name.** Samsung writes model codes like
`SM-S918B`, not "Galaxy S23 Ultra"; Sony writes `ILCE-7M4`, not "A7 IV"; Nikon writes
`NIKON Z 6` with a space and puts `NIKON CORPORATION` in Make. Getting this wrong is the main
way this task fails silently.

⚠ The UI will say "checked against N known models", never "verified". Do not pad the list with
guesses; a wrong release date produces a false accusation against a genuine photo, which is the
worst output this feature can produce.

---

## R5 — Docker packaging

**Branch** `docker/package` · **Files** `docker/Dockerfile` `docker/compose.yml` `.dockerignore`

Self-host target: someone clones the repo and gets the whole tool running locally with one
command, with no accounts and no third-party services.

- Multi-stage build: `node:22-alpine` deps → build → runner. Use Next's `output: "standalone"`.
  ⚠ `next.config.mjs` is mine — tell me and I will add that line.
- Non-root user in the runner stage.
- `compose.yml` exposes 3000 and mounts a volume for share storage at `/data`.
- `.dockerignore` must exclude `node_modules`, `.next`, `.git`, `fixtures`.

Build it against the app as it stands today; it does not need to wait for the share pipeline.

**Done when:** `docker compose up` from a clean clone serves the tool at `localhost:3000` and
a file can be inspected and cleaned.

⚠ The share pipeline needs `crypto.subtle`, which browsers only expose in a secure context.
`localhost` qualifies; a plain-http LAN IP does not. Document that in the compose file's
comments — someone self-hosting at `http://192.168.1.x:3000` will otherwise find encryption
silently unavailable.

---

## R6 — Channel measurement

**Branch** `data/channels` · **File** `lib/channels/data/channels.json`

The channel router is shipping. I am building the component; you are producing the data,
because it is legwork rather than code and it cannot be invented.

Take **one** test image with known GPS, a known camera serial and a known MPF second image —
`fixtures/build.ts` produces exactly this, or use a real phone photo. Send it to yourself
through every channel, download what arrives, re-read it with our own tool, record what
survived.

Channels and modes: WhatsApp (photo / HD photo / document), Telegram (photo / file), Instagram
post, Gmail attachment, Google Drive link, Signal, Discord.

```json
{
  "channel": "WhatsApp", "mode": "document",
  "stripsExif": false, "reEncodes": false, "keepsGps": true,
  "verifiedOn": "2026-09-14", "os": "Android 15", "appVersion": "2.24.x",
  "note": "byte-identical to the original"
}
```

⚠ **Every row needs `verifiedOn`, `os` and `appVersion`.** Rows without them render as
"unverified — do not rely on this". Platform behaviour is undocumented, changes silently and
differs by client version, so an invented row is misinformation shipped inside a security tool.
A judge with a phone can test one of these in thirty seconds.

⚠ Do not copy the published tables. MetaClean and IPTC have both published comparisons; they
are a sanity check on our numbers, not a source. Our claim is that we measured it ourselves.

---

## Suggested order

R1 → R2 → R5 → R6 → R3 → R4. PNG and WebP are quick wins that get you fluent in the handler
interface before ISOBMFF, which is the hard one. Docker is independent and can slot in whenever
you want a break from binary formats. R6 is an evening of sending files to yourself. R4 is an
evening of data entry and can happen last.

---

## What I am building, so you know what not to touch

- **Forge pipeline** — `lib/metadata/formats/jpeg/exif-write.ts` (TIFF/EXIF writer, in progress),
  `lib/forge/lint.ts` and `rules.ts`, `app/forge/`.
- **Share pipeline** — `lib/share/crypto.ts` (AES-256-GCM, fragment key), `store.ts`,
  `app/api/share/`, `app/s/[id]/`.
- **Engine core and the JPEG handler** — already built and on PR #1.

If something in my half is blocking you, say so rather than editing around it.
