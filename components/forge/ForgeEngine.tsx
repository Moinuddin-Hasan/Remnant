"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { canForge, forgeFile } from "@/lib/metadata/pipeline";
import type { SpoofProfile } from "@/lib/metadata/handler";
import type { LintResult } from "@/lib/forge/lint";
import type { Report } from "@/lib/metadata/types";

const PRESETS: ReadonlyArray<{ label: string; profile: SpoofProfile }> = [
  {
    label: "iPhone 15 Pro · Vellore",
    profile: {
      make: "Apple",
      model: "iPhone 15 Pro",
      software: "17.4.1",
      dateTime: "2024:06:01 14:30:00",
      offsetTime: "+05:30",
      latitude: 12.9716,
      longitude: 79.1588,
    },
  },
  {
    label: "Pixel 8 Pro · London",
    profile: {
      make: "Google",
      model: "Pixel 8 Pro",
      software: "HDR+ 1.0",
      dateTime: "2024:03:14 09:15:00",
      offsetTime: "+00:00",
      latitude: 51.5072,
      longitude: -0.1276,
    },
  },
];

const empty: SpoofProfile = {};

/** Re-wraps a Blob as a File so the receiving tab has a name to work with. */
const asFile = (blob: Blob, name: string, type?: string): File =>
  new File([blob], name, { type: type ?? blob.type ?? "application/octet-stream" });

interface ForgeProps {
  readonly initial?: File | null;
  readonly initialNote?: string | null;
  readonly onHandOff?: (file: File, note: string) => void;
}

export default function ForgeEngine({ initial = null, initialNote = null, onHandOff }: ForgeProps) {
  const [file, setFile] = useState<File | null>(null);
  const [profile, setProfile] = useState<SpoofProfile>(PRESETS[0]!.profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ report: Report; lint: LintResult; url: string; name: string } | null>(null);
  const [handedNote, setHandedNote] = useState<string | null>(initialNote);
  const [writable, setWritable] = useState<boolean | null>(null);
  const url = useRef<string | null>(null);
  const forged = useRef<Blob | null>(null);

  // A file carried in from the Inspect tab.
  useEffect(() => {
    if (initial) {
      setFile(initial);
      setHandedNote(initialNote);
    }
  }, [initial, initialNote]);

  useEffect(
    () => () => {
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  /**
   * Ask up front whether this format has a write path.
   *
   * An iPhone shoots HEIC by default, and HEIC has no writer — deliberately,
   * because writing its metadata resizes boxes and breaks every item offset.
   * Finding that out after filling in a profile and pressing the button is a
   * bad way to learn it.
   */
  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setWritable(null);
      return;
    }
    void canForge(file, file.name).then((ok) => {
      if (!cancelled) setWritable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const set = <K extends keyof SpoofProfile>(key: K, value: SpoofProfile[K]) =>
    setProfile((p) => ({ ...p, [key]: value }));

  const onForge = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const out = await forgeFile(file, file.name, profile);
      if (url.current) URL.revokeObjectURL(url.current);
      const objectUrl = URL.createObjectURL(out.output);
      url.current = objectUrl;
      forged.current = out.output;
      const dot = file.name.lastIndexOf(".");
      setResult({
        report: out.readBack,
        lint: out.lint,
        url: objectUrl,
        name: dot > 0 ? `${file.name.slice(0, dot)}.forged${file.name.slice(dot)}` : `${file.name}.forged`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [file, profile]);

  const field = (label: string, key: keyof SpoofProfile, placeholder = "") => (
    <label className="well field" key={key}>
      <h3>{label}</h3>
      <input
        type="text"
        value={(profile[key] as string | number | undefined) ?? ""}
        placeholder={placeholder}
        onChange={(e) =>
          set(
            key,
            (key === "latitude" || key === "longitude"
              ? e.target.value === "" ? undefined : Number(e.target.value)
              : e.target.value) as never,
          )
        }
        style={{ width: "100%" }}
      />
    </label>
  );

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2 className="t-headline-md">Source file</h2>
          <span className="meta">JPEG · PNG · WebP</span>
        </div>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && (
          <p className="note" style={{ marginBottom: 0 }}>
            <strong>{file.name}</strong>
            {handedNote ? ` · ${handedNote}` : ""}
          </p>
        )}
        {writable === false && (
          <div className="well" style={{ marginTop: "var(--space-2)" }}>
            <strong style={{ fontSize: 14 }}>This format cannot be forged.</strong>
            <p className="note" style={{ marginTop: 6 }}>
              HEIC, AVIF and MP4 store metadata as sized boxes, so writing into one shifts every
              offset after it and breaks the file. Rather than hand back something subtly
              corrupt, we refuse. Convert to JPEG first, or use Inspect &amp; clean, which does
              work on this format.
            </p>
          </div>
        )}

        <p className="note">
          Existing metadata and any embedded payload are removed before the new block is written.
          Leaving the original camera&apos;s tags beside a forged EXIF block is the first thing
          any check would catch.
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="t-headline-md">Identity to write</h2>
          <span className="meta">{PRESETS.length} presets</span>
        </div>
        <div className="actions" style={{ marginTop: 0, marginBottom: 14 }}>
          {PRESETS.map((p) => (
            <button className="btn" key={p.label} onClick={() => setProfile(p.profile)}>
              {p.label}
            </button>
          ))}
          <button className="btn" onClick={() => setProfile(empty)}>Clear</button>
        </div>

        <div className="grid">
          {field("Make", "make", "Apple")}
          {field("Model", "model", "iPhone 15 Pro")}
          {field("Software", "software", "17.4.1")}
          {field("Artist", "artist")}
          {field("Capture time", "dateTime", "2024:06:01 14:30:00")}
          {field("UTC offset", "offsetTime", "+05:30")}
          {field("Latitude", "latitude", "12.9716")}
          {field("Longitude", "longitude", "79.1588")}
        </div>

        {error && <p className="err">{error}</p>}

        <div className="actions">
          <button className="btn btn-primary" onClick={onForge} disabled={!file || busy || writable === false}>
            {busy ? "Writing…" : "Write metadata"}
          </button>
          {result && (
            <>
              <a href={result.url} download={result.name}>
                <button className="btn">Download</button>
              </a>
              {onHandOff && (
                <button className="btn"
                  onClick={() => {
                    if (!forged.current) return;
                    onHandOff(
                      asFile(forged.current, result.name, "image/jpeg"),
                      "Forged in the previous step.",
                    );
                  }}
                >
                  Check it in the inspector
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {result && (
        <>
          <div className="card">
            <div className="card-head">
              <h2 className="t-headline-md">Read back from the file we produced</h2>
              <span className="meta">not the values you typed</span>
            </div>
            {result.report.findings
              .filter((f) => f.id.startsWith("exif."))
              .map((f) => (
                <div className="row" key={f.id}>
                  <span className="dot benign" aria-hidden />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row-label">{f.label}</div>
                    <div className="row-value">{f.value}</div>
                  </div>
                </div>
              ))}
          </div>

          <div className={`card ${result.lint.contradictions.length > 1 ? "card-warn" : "card-ok"}`}>
            <div className="card-head">
              <h2 className="t-headline-md">Consistency: {result.lint.score}/100</h2>
              <span className="meta">checked against {result.lint.checkedModels} known models</span>
            </div>

            {result.lint.contradictions.map((c) => (
              <div className="row" key={c.rule}>
                <span className={`dot ${c.weight > 0.6 ? "critical" : "notable"}`} aria-hidden />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row-label">{c.message}</div>
                  <div className="row-value" style={{ fontFamily: "var(--sans)" }}>
                    Also happens when {c.alsoHappensWhen}
                  </div>
                </div>
              </div>
            ))}

            <p className="note">
              This score measures whether the metadata agrees with itself. It says nothing about
              whether the file would survive examination — the encoder fingerprint, compression
              history and sensor noise all persist through any metadata edit:
            </p>
            <ul className="list">
              {result.lint.outOfReach.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
}
