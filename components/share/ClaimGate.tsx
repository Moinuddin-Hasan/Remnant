"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { claimShare, shareStatus } from "@/lib/share/client";

type State = "checking" | "ready" | "claiming" | "done" | "gone" | "error";

const mins = (ms: number) => Math.max(0, Math.round(ms / 60000));

/**
 * The recipient's view.
 *
 * Critically, landing here consumes nothing. The liveness check is a GET; the
 * bytes only move on an explicit click, which is a POST. That is what stops a
 * link-preview crawler — which fires within seconds of the URL being pasted
 * into any chat app — from burning the share before a human ever sees it.
 */
export default function ClaimGate({ id }: { id: string }) {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [expiresIn, setExpiresIn] = useState(0);
  const [file, setFile] = useState<{ url: string; name: string; size: number } | null>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await shareStatus(id);
      if (cancelled) return;
      if (!status) {
        setState("gone");
        return;
      }
      setRemaining(status.remaining);
      setExpiresIn(status.expiresAt - Date.now());
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const onClaim = useCallback(async () => {
    setState("claiming");
    setError(null);
    try {
      const fragment = window.location.hash.slice(1);
      if (!fragment) throw new Error("This link is missing its key. Copy the whole URL, including the part after the #.");

      const { blob, name } = await claimShare(id, fragment);
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      setFile({ url, name, size: blob.size });
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, [id]);

  if (state === "checking") return <p className="sub">Checking this link…</p>;

  if (state === "gone") {
    return (
      <div className="panel">
        <div className="panel-title">
          <h2>This link is no longer available</h2>
        </div>
        <p className="note" style={{ marginTop: 0 }}>
          It was claimed, revoked by the sender, or it expired. Links are single-use by default
          and nothing about them is recoverable — ask the sender for a new one.
        </p>
      </div>
    );
  }

  if (state === "done" && file) {
    return (
      <div className="panel verify-ok">
        <div className="panel-title">
          <h2>Decrypted in your browser</h2>
          <span className="meta">{file.size.toLocaleString()} bytes</span>
        </div>
        <p className="note" style={{ marginTop: 0 }}>
          The file was decrypted here, on your device, using the key from the end of the URL.
          The server sent ciphertext and never held the key.
        </p>
        <div className="actions">
          <a href={file.url} download={file.name}>
            <button className="primary">Save {file.name}</button>
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title">
        <h2>A file is waiting for you</h2>
        <span className="meta">
          {remaining} claim{remaining === 1 ? "" : "s"} left · expires in {mins(expiresIn)} min
        </span>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        Opening this page did not consume the link. It is spent only when you click below, so a
        chat app generating a preview cannot use it up before you do.
      </p>
      {error && <p className="err">{error}</p>}
      <div className="actions">
        <button className="primary" onClick={onClaim} disabled={state === "claiming"}>
          {state === "claiming" ? "Decrypting…" : "Claim and decrypt"}
        </button>
      </div>
    </div>
  );
}
