/**
 * Storage contract for share links. No runtime imports, so it is safe on both
 * sides of the wire.
 *
 * What a store holds is deliberately thin: ciphertext and an opaque id. The
 * filename, the MIME type and the byte count all live *inside* the encrypted
 * payload, so no implementation of this interface can learn them.
 */

export interface ShareRecord {
  readonly id: string;
  /** Ciphertext length, which is padded — it does not reveal the plaintext size. */
  readonly size: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly remaining: number;
}

export interface ShareStore {
  /** `manageTokenHash` authorises revocation; the token itself is never stored. */
  put(args: {
    id: string;
    ciphertext?: Uint8Array;
    blobUrl?: string;
    size: number;
    ttlMs: number;
    maxClaims: number;
    manageTokenHash: string;
  }): Promise<ShareRecord>;

  /** Liveness WITHOUT consuming a claim, so a link preview cannot burn a share. */
  stat(id: string): Promise<ShareRecord | null>;

  /** Consumes one claim and returns the bytes, or null if spent or expired. */
  claim(id: string): Promise<{ record: ShareRecord; ciphertext: Uint8Array } | null>;

  /** Revocation from the dashboard. Requires the creator's token. */
  revoke(id: string, manageToken: string): Promise<boolean>;

  /**
   * `verified` means we re-checked and the bytes are genuinely gone. On a
   * small quota a delete that silently failed is what fills the store, so the
   * caller gets told rather than assuming.
   */
  destroy(id: string): Promise<DeleteResult>;

  usage(): Promise<StorageUsage>;

  /** Reclaims orphaned objects. See the implementation for why they exist. */
  sweep(graceMs?: number): Promise<SweepResult>;
}

export interface DeleteResult {
  readonly deleted: boolean;
  readonly verified: boolean;
}

export interface StorageUsage {
  readonly count: number;
  readonly bytes: number;
  readonly quota: number;
}

export interface SweepResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly freed: number;
}

export const DEFAULT_TTL_MS = 60 * 60 * 1000;
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_CLAIMS = 1;
export const MAX_CLAIMS = 50;

/** 100 MB plaintext ceiling, plus room for padding and the GCM tag. */
export const MAX_PLAINTEXT = 100 * 1024 * 1024;
export const MAX_CIPHERTEXT = MAX_PLAINTEXT + 1024 * 1024;

/**
 * The hosted store's quota. Small enough that leaked objects matter, which is
 * why `sweep()` exists and why deletion is verified rather than assumed.
 */
export const QUOTA_BYTES = 256 * 1024 * 1024;
/** Refuse new uploads past this, leaving headroom rather than failing at 100%. */
export const QUOTA_SOFT_LIMIT = Math.floor(QUOTA_BYTES * 0.85);
