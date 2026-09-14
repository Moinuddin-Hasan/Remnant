"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createShare,
  forgetExpired,
  linkFor,
  listShares,
  revokeShare,
  shareConfig,
  shareStatus,
  storageUsage,
  sweepStorage,
  type LocalShare,
  type ShareConfig,
  type StorageUsage,
} from "@/lib/share/client";
import { cleanFile } from "@/lib/metadata/pipeline";

type Liveness = Record<string, { live: boolean; remaining: number } | undefined>;

const mins = (ms: number) => Math.max(0, Math.round(ms / 60000));
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * The creator's view.
 *
 * Everything listed here comes from `localStorage` — filenames, keys, manage
 * tokens. The server holds none of it, which is the point worth showing on
 * stage: this page can say "beach.mp4, 42 minutes left" while the same link
 * queried against the API returns an opaque id and a rounded size.
 */
export default function Dashboard() {
  const [config, setConfig] = useState<ShareConfig | null>(null);
  const [shares, setShares] = useState<LocalShare[]>([]);
  const [live, setLive] = useState<Liveness>({});
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [claims, setClaims] = useState(1);
  const [ttlMins, setTtlMins] = useState(60);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [swept, setSwept] = useState<string | null>(null);
  const [handedNote, setHandedNote] = useState<string | null>(null);
  const [stripFirst, setStripFirst] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (list: readonly LocalShare[]) => {
    const entries = await Promise.all(
      list.map(async (s) => [s.id, (await shareStatus(s.id)) ?? undefined] as const),
    );
    setLive(Object.fromEntries(entries));
  }, []);

  const refreshUsage = useCallback(() => {
    storageUsage().then(setUsage).catch(() => setUsage(null));
  }, []);

  useEffect(() => {
    forgetExpired();
    const list = listShares();
    setShares(list);
    void refresh(list);
    shareConfig().then(setConfig).catch(() => setConfig(null));
    refreshUsage();

  }, [refresh, refreshUsage]);

  const onSweep = useCallback(async () => {
    setSweeping(true);
    setSwept(null);
    try {
      const result = await sweepStorage(passphrase || undefined);
      setSwept(
        result
          ? `reclaimed ${result.deleted} object(s), ${(result.freed / 1048576).toFixed(1)} MB`
          : "sweep refused — check the passphrase",
      );
      refreshUsage();
    } finally {
      setSweeping(false);
    }
  }, [passphrase, refreshUsage]);

  const onCreate = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      // Cleaning happens here rather than on another route: the sealed pages
      // cannot navigate without a full page load, which would drop the file.
      // Doing it inline also means nobody can share a file they forgot to strip.
      let payload: Blob = file;
      const label = file.name;
      if (stripFirst) {
        setProgress(0.02);
        try {
          const cleaned = await cleanFile(file, file.name);
          payload = cleaned.output;
          setHandedNote(
            cleaned.verify.ok
              ? `stripped and verified · ${cleaned.verify.bytesBefore - cleaned.verify.bytesAfter} bytes removed`
              : `partially cleaned · ${cleaned.verify.survived.length} item(s) remain`,
          );
        } catch {
          setHandedNote("no strip path for this format — sharing it unchanged");
        }
      }
      await createShare(payload, label, {
        ttlMs: ttlMins * 60_000,
        maxClaims: claims,
        passphrase: passphrase || undefined,
        onProgress: setProgress,
      });
      const list = listShares();
      setShares(list);
      void refresh(list);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [file, ttlMins, claims, passphrase, refresh, stripFirst]);

  const onRevoke = useCallback(
    async (share: LocalShare) => {
      await revokeShare(share);
      const list = listShares();
      setShares(list);
      void refresh(list);
    },
    [refresh],
  );

  const onCopy = useCallback(async (share: LocalShare) => {
    try {
      await navigator.clipboard.writeText(linkFor(share));
      setCopied(share.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("Could not copy — select the link and copy it manually.");
    }
  }, []);

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2 className="t-headline-md">Share a file</h2>
          <span className="meta">
            {config ? (config.mode === "hosted" ? "hosted storage" : "local storage") : "…"}
          </span>
        </div>

        <input
          ref={inputRef}
          type="file"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setHandedNote(null);
          }}
          style={{ marginBottom: 8 }}
        />
        {file && (
          <p className="note" style={{ marginTop: 0, marginBottom: 14 }}>
            <strong>{file.name}</strong> · {kb(file.size)}
            {handedNote ? ` · ${handedNote}` : ""}
          </p>
        )}

        <label
          style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, fontSize: 13.5 }}
        >
          <input
            type="checkbox"
            checked={stripFirst}
            onChange={(e) => setStripFirst(e.target.checked)}
          />
          Strip metadata before encrypting
        </label>

        <div className="grid" style={{ marginBottom: 14 }}>
          <label className="well field">
            <h3>Claims</h3>
            <input
              type="number"
              min={1}
              max={config?.maxClaims ?? 50}
              value={claims}
              onChange={(e) => setClaims(Math.max(1, Number(e.target.value)))}
              style={{ width: "100%" }}
            />
            <p>How many times the link can be opened.</p>
          </label>
          <label className="well field">
            <h3>Expires in (min)</h3>
            <input
              type="number"
              min={1}
              max={1440}
              value={ttlMins}
              onChange={(e) => setTtlMins(Math.max(1, Number(e.target.value)))}
              style={{ width: "100%" }}
            />
            <p>After this it is unreachable.</p>
          </label>
          {config?.passphraseRequired && (
            <label className="well field">
              <h3>Passphrase</h3>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                style={{ width: "100%" }}
              />
              <p>Required by this instance.</p>
            </label>
          )}
        </div>

        {config && !config.ready && (
          <div className="well" style={{ marginBottom: "var(--space-2)" }}>
            <strong style={{ fontSize: 14 }}>Sharing is not configured on this deployment.</strong>
            <p className="note" style={{ marginTop: 6 }}>
              This host has a read-only filesystem, so hosted storage is required. Missing:{" "}
              <code>{config.missing.join(", ")}</code>. Set them in the project&apos;s environment
              variables and redeploy — variables only reach deployments created after they are
              set. Inspect, clean and forge all still work; they never needed a server.
            </p>
          </div>
        )}

        {error && <p className="err">{error}</p>}

        <div className="actions">
          <button
            className="btn btn-primary"
            onClick={onCreate}
            disabled={!file || busy || (config ? !config.ready : false)}
          >
            {busy ? `Encrypting… ${Math.round(progress * 100)}%` : "Encrypt and upload"}
          </button>
        </div>

        <p className="note">
          The file is encrypted here before anything is uploaded. The key goes into the link
          after the <code style={{ fontFamily: "var(--mono)" }}>#</code>, which browsers never
          send in a request — so the server stores ciphertext it has no key for.
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="t-headline-md">Storage</h2>
          <span className="meta">
            {usage
              ? `${(usage.bytes / 1048576).toFixed(1)} of ${(usage.quota / 1048576).toFixed(0)} MB · ${usage.count} object(s)`
              : "…"}
          </span>
        </div>
        {usage && (
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: "var(--rule)",
              overflow: "hidden",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                width: `${Math.min(100, (usage.bytes / usage.quota) * 100)}%`,
                height: "100%",
                background: usage.bytes / usage.quota > 0.85 ? "var(--leak)" : "var(--okay)",
              }}
            />
          </div>
        )}
        <p className="note" style={{ marginTop: 0 }}>
          Expired shares and abandoned uploads leave ciphertext behind that nothing references.
          Sweeping deletes them and confirms afterwards that the objects are actually gone.
        </p>
        <div className="actions">
          <button className="btn" onClick={onSweep} disabled={sweeping}>
            {sweeping ? "Sweeping…" : "Reclaim orphaned files"}
          </button>
          {swept && <span className="meta">{swept}</span>}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="t-headline-md">Your links</h2>
          <span className="meta">{shares.length} on this device</span>
        </div>

        {shares.length === 0 ? (
          <p className="note" style={{ marginTop: 0 }}>
            Nothing yet. Links you create are remembered in this browser only — the server has
            no idea which are yours.
          </p>
        ) : (
          shares.map((s) => {
            const status = live[s.id];
            const dead = !status?.live;
            return (
              <div className="row" key={s.id}>
                <span className={`dot ${dead ? "benign" : "critical"}`} aria-hidden />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row-label">
                    {s.name} <span style={{ color: "var(--muted)" }}>· {kb(s.size)}</span>
                  </div>
                  <div className="row-value">
                    {dead
                      ? "claimed, revoked or expired"
                      : `${status?.remaining ?? 0} claim(s) left · ${mins(s.expiresAt - Date.now())} min left`}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flex: "none" }}>
                  {!dead && (
                    <button className="btn" onClick={() => onCopy(s)}>{copied === s.id ? "Copied" : "Copy link"}</button>
                  )}
                  <button className="btn" onClick={() => onRevoke(s)}>{dead ? "Remove" : "Revoke"}</button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
