"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { forgeFile } from "@/lib/metadata/pipeline";
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

export default function ForgeEngine() {
  const [file, setFile] = useState<File | null>(null);
  const [profile, setProfile] = useState<SpoofProfile>(PRESETS[0]!.profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ report: Report; lint: LintResult; url: string; name: string } | null>(null);
  const url = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

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
    <label className="layer" key={key}>
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
      <div className="panel">
        <div className="panel-title">
          <h2>Source file</h2>
          <span className="meta">JPEG</span>
        </div>
        <input type="file" accept="image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <p className="note">
          Existing metadata and any embedded payload are removed before the new block is written.
          Leaving the original camera&apos;s tags beside a forged EXIF block is the first thing
          any check would catch.
        </p>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h2>Identity to write</h2>
          <span className="meta">{PRESETS.length} presets</span>
        </div>
        <div className="actions" style={{ marginTop: 0, marginBottom: 14 }}>
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => setProfile(p.profile)}>
              {p.label}
            </button>
          ))}
          <button onClick={() => setProfile(empty)}>Clear</button>
        </div>

        <div className="layers">
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
          <button className="primary" onClick={onForge} disabled={!file || busy}>
            {busy ? "Writing…" : "Write metadata"}
          </button>
          {result && (
            <a href={result.url} download={result.name}>
              <button>Download</button>
            </a>
          )}
        </div>
      </div>

      {result && (
        <>
          <div className="panel">
            <div className="panel-title">
              <h2>Read back from the file we produced</h2>
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

          <div className={`panel ${result.lint.contradictions.length > 1 ? "verify-bad" : "verify-ok"}`}>
            <div className="panel-title">
              <h2>Consistency: {result.lint.score}/100</h2>
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
            <ul className="unhandled">
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
