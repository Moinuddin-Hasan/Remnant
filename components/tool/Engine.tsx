"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clean, inspect } from "@/lib/metadata/worker/client";
import { extractAsset } from "@/lib/metadata/pipeline";
import type { EmbeddedAsset, Report, VerifyResult } from "@/lib/metadata/types";
import FindingList from "./FindingList";
import RemnantReveal from "./RemnantReveal";
import VerifyPanel from "./VerifyPanel";
import LayerPanel from "./LayerPanel";

type Phase = "idle" | "reading" | "ready" | "cleaning" | "cleaned";

interface AssetPreview {
  readonly asset: EmbeddedAsset;
  readonly url: string | null;
}

const kb = (n: number) => `${n.toLocaleString()} bytes`;

export default function Engine() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [canClean, setCanClean] = useState(false);
  const [previews, setPreviews] = useState<AssetPreview[]>([]);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [outUrl, setOutUrl] = useState<string | null>(null);
  const [outName, setOutName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  const releaseUrls = useCallback(() => {
    for (const u of urls.current) URL.revokeObjectURL(u);
    urls.current = [];
  }, []);

  useEffect(() => releaseUrls, [releaseUrls]);

  const track = (url: string) => {
    urls.current.push(url);
    return url;
  };

  const reset = useCallback(() => {
    releaseUrls();
    setPreviews([]);
    setVerify(null);
    setOutUrl(null);
    setReport(null);
    setError(null);
  }, [releaseUrls]);

  const onFile = useCallback(
    async (f: File) => {
      reset();
      setFile(f);
      setPhase("reading");
      try {
        const { report: r, canClean: cc } = await inspect(f);
        setReport(r);
        setCanClean(cc);

        // Render the remnant payload. A thumbnail has no byte range here (it is
        // located inside APP1 by the tag reader), so only ranged assets preview.
        setPreviews(
          r.assets.map((asset) => {
            const hasRange = asset.range.end > asset.range.start;
            if (!hasRange || !asset.mime.startsWith("image/")) return { asset, url: null };
            return { asset, url: track(URL.createObjectURL(extractAsset(f, asset.range, asset.mime))) };
          }),
        );
        setPhase("ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("idle");
      }
    },
    [reset],
  );

  const onClean = useCallback(async () => {
    if (!file) return;
    setPhase("cleaning");
    setError(null);
    try {
      const res = await clean(file);
      setVerify(res.verify);
      setOutUrl(track(URL.createObjectURL(res.output)));
      const dot = file.name.lastIndexOf(".");
      setOutName(
        dot > 0 ? `${file.name.slice(0, dot)}.cleaned${file.name.slice(dot)}` : `${file.name}.cleaned`,
      );
      setPhase("cleaned");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("ready");
    }
  }, [file]);

  const pick = (list: FileList | null) => {
    const f = list?.[0];
    if (f) void onFile(f);
  };

  return (
    <>
      <div
        className="drop"
        data-over={over}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          pick(e.dataTransfer.files);
        }}
      >
        <strong>{file ? file.name : "Drop a file, or click to choose one"}</strong>
        <span>
          {file
            ? `${kb(file.size)} · ${report?.formatLabel ?? "reading…"}`
            : "JPEG is fully supported. Anything else gets a raw byte scan and an honest answer."}
        </span>
        <input
          ref={inputRef}
          type="file"
          hidden
          onChange={(e) => pick(e.target.files)}
        />
      </div>

      {error && <p className="err">{error}</p>}
      {phase === "reading" && <p className="sub" style={{ marginTop: 18 }}>Reading…</p>}

      {report && (
        <>
          <RemnantReveal previews={previews} />

          <FindingList report={report} />

          <LayerPanel />

          {report.unhandled.length > 0 && (
            <div className="panel">
              <div className="panel-title">
                <h2>What this did not inspect</h2>
                <span className="meta">stated, not hidden</span>
              </div>
              <ul className="unhandled">
                {report.unhandled.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="actions">
            <button className="primary" onClick={onClean} disabled={!canClean || phase === "cleaning"}>
              {phase === "cleaning" ? "Cleaning…" : "Clean it"}
            </button>
            {outUrl && (
              <a href={outUrl} download={outName}>
                <button>Download cleaned file</button>
              </a>
            )}
            <button
              onClick={() => {
                setFile(null);
                setPhase("idle");
                reset();
              }}
            >
              Start over
            </button>
          </div>

          {!canClean && (
            <p className="note">
              This format is read-only here. We will not rewrite a container we do not
              understand — a broken file is worse than a leaky one.
            </p>
          )}
        </>
      )}

      {verify && <VerifyPanel verify={verify} />}
    </>
  );
}
