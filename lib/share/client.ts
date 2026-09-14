"use client";

import { upload } from "@vercel/blob/client";
import { decryptShare, encryptForShare } from "./crypto";
import { blobPathFor, hashToken, newManageToken, newShareId } from "./id";

/**
 * Browser side of the share flow.
 *
 * Order matters: the id is generated first because it is bound into the
 * ciphertext as additional authenticated data, then the file is encrypted,
 * then the ciphertext is uploaded, and only then is anything registered with
 * the server. At no point does a key, a filename or a MIME type leave this
 * module.
 */

const LOCAL_KEY = "remnant.shares.v1";

export interface ShareConfig {
  readonly mode: "hosted" | "local";
  /** False when this deployment has no writable storage at all. */
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly maxBytes: number;
  readonly passphraseRequired: boolean;
  readonly defaultTtlMs: number;
  readonly maxTtlMs: number;
  readonly maxClaims: number;
}

/** What the creator's browser remembers. The server holds none of this. */
export interface LocalShare {
  readonly id: string;
  readonly fragment: string;
  readonly name: string;
  readonly size: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly maxClaims: number;
  readonly manageToken: string;
}

export interface ShareOptions {
  readonly ttlMs?: number;
  readonly maxClaims?: number;
  readonly passphrase?: string;
  readonly onProgress?: (fraction: number) => void;
}

export async function shareConfig(): Promise<ShareConfig> {
  const res = await fetch("/api/share", { cache: "no-store" });
  if (!res.ok) throw new Error("Sharing is unavailable.");
  return (await res.json()) as ShareConfig;
}

const toBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000; // avoid blowing the argument limit on large files
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

export async function createShare(
  file: Blob,
  filename: string,
  options: ShareOptions = {},
): Promise<LocalShare> {
  if (!window.isSecureContext) {
    throw new Error(
      "Encryption needs a secure context. Use https, or localhost — a plain http:// LAN " +
        "address does not qualify and Web Crypto will be unavailable.",
    );
  }

  const config = await shareConfig();
  const id = newShareId();
  const manageToken = newManageToken();

  options.onProgress?.(0.05);
  const { ciphertext, fragment } = await encryptForShare(file, filename, id);
  options.onProgress?.(0.35);

  let blobUrl: string | undefined;
  let inlineCiphertext: string | undefined;

  if (config.mode === "hosted") {
    const result = await upload(blobPathFor(id), new Blob([ciphertext.slice().buffer as ArrayBuffer]), {
      access: "public", // the payload is ciphertext; confidentiality is the key, not the ACL
      handleUploadUrl: "/api/share/upload",
      contentType: "application/octet-stream",
      clientPayload: JSON.stringify({ passphrase: options.passphrase ?? "" }),
      onUploadProgress: ({ percentage }) => options.onProgress?.(0.35 + (percentage / 100) * 0.55),
    });
    blobUrl = result.url;
  } else {
    inlineCiphertext = toBase64(ciphertext);
    options.onProgress?.(0.8);
  }

  const res = await fetch("/api/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      blobUrl,
      ciphertext: inlineCiphertext,
      size: ciphertext.length,
      ttlMs: options.ttlMs,
      maxClaims: options.maxClaims,
      manageTokenHash: await hashToken(manageToken),
      passphrase: options.passphrase,
    }),
  });

  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
    throw new Error(error || "Could not create the share.");
  }

  const record = (await res.json()) as { expiresAt: number; remaining: number };
  options.onProgress?.(1);

  const local: LocalShare = {
    id,
    fragment,
    name: filename,
    size: file.size,
    createdAt: Date.now(),
    expiresAt: record.expiresAt,
    maxClaims: record.remaining,
    manageToken,
  };
  remember(local);
  return local;
}

export function linkFor(share: LocalShare): string {
  return `${window.location.origin}/s/${share.id}#${share.fragment}`;
}

/**
 * Claim and decrypt. The fragment never reaches the server — it is read from
 * `location.hash`, which browsers do not put in a request.
 */
export async function claimShare(
  id: string,
  fragment: string,
): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(`/api/share/${id}`, { method: "POST" });
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
    throw new Error(error || "This link is no longer available.");
  }
  const ciphertext = new Uint8Array(await res.arrayBuffer());
  const out = await decryptShare(ciphertext, fragment, id);
  return { blob: out.blob, name: out.name };
}

export async function shareStatus(
  id: string,
): Promise<{ live: boolean; remaining: number; expiresAt: number } | null> {
  const res = await fetch(`/api/share/${id}`, { cache: "no-store" });
  if (!res.ok) return null;
  const body = (await res.json()) as { remaining: number; expiresAt: number };
  return { live: true, remaining: body.remaining, expiresAt: body.expiresAt };
}

export interface StorageUsage {
  readonly count: number;
  readonly bytes: number;
  readonly quota: number;
  readonly mode: "hosted" | "local";
}

export async function storageUsage(): Promise<StorageUsage | null> {
  const res = await fetch("/api/share/storage", { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as StorageUsage;
}

/** Reclaims orphaned ciphertext — expired shares and abandoned uploads. */
export async function sweepStorage(
  passphrase?: string,
): Promise<{ deleted: number; freed: number } | null> {
  const res = await fetch("/api/share/storage", {
    method: "POST",
    headers: passphrase ? { "x-remnant-passphrase": passphrase } : {},
  });
  if (!res.ok) return null;
  return (await res.json()) as { deleted: number; freed: number };
}

export async function revokeShare(share: LocalShare): Promise<boolean> {
  const res = await fetch(`/api/share/${share.id}`, {
    method: "DELETE",
    headers: { "x-remnant-manage": share.manageToken },
  });
  const ok = res.ok;
  if (ok || res.status === 403 || res.status === 404) forget(share.id);
  return ok;
}

/* -------------------------------------------------------------- local list */

export function listShares(): LocalShare[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as LocalShare[]).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function write(list: readonly LocalShare[]): void {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch {
    // Private browsing, or storage disabled. The share still works; only the
    // dashboard list is lost, so failing silently is the right call.
  }
}

function remember(share: LocalShare): void {
  write([share, ...listShares().filter((s) => s.id !== share.id)]);
}

export function forget(id: string): void {
  write(listShares().filter((s) => s.id !== id));
}

export function forgetExpired(): void {
  const now = Date.now();
  write(listShares().filter((s) => s.expiresAt > now));
}
