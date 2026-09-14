/**
 * Share ids are generated in the BROWSER, before encryption.
 *
 * The id is bound into the ciphertext as additional authenticated data, so it
 * has to exist before we encrypt — which rules out the server minting it. 128
 * bits of randomness makes both collision and enumeration irrelevant, and the
 * server rejects any id that is already taken.
 *
 * This module deliberately imports nothing: it is used on both sides.
 */

export const SHARE_ID = /^[0-9a-f]{32}$/;

export function newShareId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Secret that authorises revoking a share from the dashboard. Never leaves the creator. */
export function newManageToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(`remnant-manage:${token}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const blobPathFor = (id: string): string => `shares/${id}.bin`;
