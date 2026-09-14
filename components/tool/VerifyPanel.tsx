"use client";

import type { VerifyResult } from "@/lib/metadata/types";

/**
 * The tool is not allowed to print "clean" off the back of a write — only off
 * the back of re-reading what it produced. This panel is that result, and it
 * says "partially cleaned" whenever anything survived.
 */
export default function VerifyPanel({ verify }: { verify: VerifyResult }) {
  const removed = verify.bytesBefore - verify.bytesAfter;

  return (
    <div className={`panel ${verify.ok ? "verify-ok" : "verify-bad"}`}>
      <div className="panel-title">
        <h2>{verify.ok ? "Verified clean" : "Partially cleaned"}</h2>
        <span className="meta">re-read with the same engine</span>
      </div>

      <div className="row">
        <span className="dot benign" aria-hidden />
        <div>
          <div className="row-label">Bytes removed</div>
          <div className="row-value">
            {verify.bytesBefore.toLocaleString()} → {verify.bytesAfter.toLocaleString()} (
            {removed.toLocaleString()} removed)
          </div>
        </div>
      </div>

      {verify.ok ? (
        <p className="note">
          We re-parsed the file we just produced and found no metadata, no embedded payload, and
          none of the original sensitive strings anywhere in the bytes. The compressed image
          data was never touched, so the pixels are identical to the original.
        </p>
      ) : (
        <>
          {verify.survived.map((f) => (
            <div className="row" key={f.id}>
              <span className={`dot ${f.severity}`} aria-hidden />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row-label">Still present: {f.label}</div>
                <div className="row-value">{f.value}</div>
              </div>
            </div>
          ))}
          {verify.literalsFound.length > 0 && (
            <div className="row">
              <span className="dot critical" aria-hidden />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row-label">Original values found in the output bytes</div>
                <div className="row-value">{verify.literalsFound.join(" · ")}</div>
              </div>
            </div>
          )}
          <p className="note">
            Something survived the strip, so this file is not clean and we will not say it is.
          </p>
        </>
      )}
    </div>
  );
}
