import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decryptShare, encryptForShare } from "./crypto";
import { hashToken, newManageToken, newShareId } from "./id";
import { FileShareStore } from "./store-file";
import { MAX_PLAINTEXT } from "./types";

const dir = await mkdtemp(path.join(tmpdir(), "remnant-share-"));
const store = new FileShareStore(dir);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(
  id: string,
  bytes: number[],
  ttlMs = 60_000,
  maxClaims = 1,
  manageToken = newManageToken(),
) {
  const record = await store.put({
    id,
    ciphertext: new Uint8Array(bytes),
    size: bytes.length,
    ttlMs,
    maxClaims,
    manageTokenHash: await hashToken(manageToken),
  });
  return { record, manageToken };
}

describe("share crypto", () => {
  it("round-trips a file through encrypt and decrypt", async () => {
    const id = newShareId();
    const blob = new Blob(["the quick brown fox"], { type: "text/plain" });
    const { ciphertext, fragment } = await encryptForShare(blob, "secret.txt", id);

    const out = await decryptShare(ciphertext, fragment, id);
    expect(out.name).toBe("secret.txt");
    expect(out.type).toBe("text/plain");
    expect(await out.blob.text()).toBe("the quick brown fox");
  });

  it("hides the filename and MIME type inside the ciphertext", async () => {
    const id = newShareId();
    const { ciphertext } = await encryptForShare(new Blob(["payload"]), "resume-final.pdf", id);
    const asText = Buffer.from(ciphertext).toString("latin1");
    expect(asText).not.toContain("resume-final");
    expect(asText).not.toContain("payload");
  });

  it("pads so ciphertext length does not reveal plaintext length", async () => {
    const id = newShareId();
    const small = await encryptForShare(new Blob(["a"]), "a.txt", id);
    const larger = await encryptForShare(new Blob(["a".repeat(5000)]), "b.txt", id);
    expect(small.ciphertext.length).toBe(larger.ciphertext.length);
  });

  it("refuses a ciphertext moved to a different share id", async () => {
    const id = newShareId();
    const { ciphertext, fragment } = await encryptForShare(new Blob(["bound"]), "b.txt", id);
    await expect(decryptShare(ciphertext, fragment, newShareId())).rejects.toThrow(/Decryption failed/);
  });

  it("refuses a tampered ciphertext", async () => {
    const id = newShareId();
    const { ciphertext, fragment } = await encryptForShare(new Blob(["intact"]), "c.txt", id);
    const tampered = ciphertext.slice();
    tampered[10] = tampered[10]! ^ 0xff;
    await expect(decryptShare(tampered, fragment, id)).rejects.toThrow(/Decryption failed/);
  });

  it("refuses the wrong key", async () => {
    const id = newShareId();
    const { ciphertext } = await encryptForShare(new Blob(["secret"]), "d.txt", id);
    const other = await encryptForShare(new Blob(["other"]), "e.txt", id);
    await expect(decryptShare(ciphertext, other.fragment, id)).rejects.toThrow(/Decryption failed/);
  });

  it("rejects a file over the size cap", async () => {
    const big = new Blob([new Uint8Array(MAX_PLAINTEXT + 1)]);
    await expect(encryptForShare(big, "big.bin", newShareId())).rejects.toThrow(/share limit/);
  });
});

describe("share store", () => {
  it("stat does not consume a claim, so a crawler cannot burn the link", async () => {
    const id = newShareId();
    await put(id, [1, 2, 3]);

    expect((await store.stat(id))?.remaining).toBe(1);
    expect((await store.stat(id))?.remaining).toBe(1);

    const claimed = await store.claim(id);
    expect(claimed).not.toBeNull();
    expect(Array.from(claimed!.ciphertext)).toEqual([1, 2, 3]);
  });

  it("burns after the last claim", async () => {
    const id = newShareId();
    await put(id, [9]);
    expect(await store.claim(id)).not.toBeNull();
    expect(await store.claim(id)).toBeNull();
    expect(await store.stat(id)).toBeNull();
  });

  it("serialises concurrent claims so the cap cannot be exceeded", async () => {
    const id = newShareId();
    await put(id, [7]);
    const results = await Promise.all([store.claim(id), store.claim(id), store.claim(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("honours a claim cap above one", async () => {
    const id = newShareId();
    await put(id, [5], 60_000, 3);
    const results = await Promise.all([
      store.claim(id), store.claim(id), store.claim(id), store.claim(id), store.claim(id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it("expires by TTL", async () => {
    const id = newShareId();
    await put(id, [1], -1, 5);
    expect(await store.stat(id)).toBeNull();
    expect(await store.claim(id)).toBeNull();
  });

  it("never returns the manage token hash to a caller", async () => {
    const id = newShareId();
    const { record } = await put(id, [4]);
    expect(JSON.stringify(record)).not.toContain("manageTokenHash");
    expect(JSON.stringify(await store.stat(id))).not.toContain("manageTokenHash");
  });
});

describe("revocation", () => {
  it("revokes with the creator's token and kills the link immediately", async () => {
    const id = newShareId();
    const { manageToken } = await put(id, [1, 2], 60_000, 5);

    expect(await store.revoke(id, manageToken)).toBe(true);
    expect(await store.stat(id)).toBeNull();
    expect(await store.claim(id)).toBeNull();
  });

  it("refuses revocation with the wrong token", async () => {
    const id = newShareId();
    await put(id, [1, 2], 60_000, 5);

    expect(await store.revoke(id, newManageToken())).toBe(false);
    expect(await store.stat(id)).not.toBeNull(); // still live
  });

  it("refuses revocation of an unknown share", async () => {
    expect(await store.revoke(newShareId(), newManageToken())).toBe(false);
  });
});

describe("storage hygiene", () => {
  it("reports usage that tracks what is actually stored", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "remnant-usage-"));
    const s = new FileShareStore(fresh);
    try {
      expect((await s.usage()).bytes).toBe(0);

      await s.put({
        id: newShareId(),
        ciphertext: new Uint8Array(500),
        size: 500,
        ttlMs: 60_000,
        maxClaims: 1,
        manageTokenHash: await hashToken(newManageToken()),
      });

      const used = await s.usage();
      expect(used.count).toBe(1);
      expect(used.bytes).toBe(500);
      expect(used.quota).toBeGreaterThan(0);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("confirms deletion rather than assuming it", async () => {
    const id = newShareId();
    await put(id, [1, 2, 3]);

    const first = await store.destroy(id);
    expect(first.deleted).toBe(true);
    expect(first.verified).toBe(true);

    // Deleting again is honest about there being nothing to delete.
    const second = await store.destroy(id);
    expect(second.deleted).toBe(false);
    expect(second.verified).toBe(true);
  });

  it("sweeps ciphertext whose metadata is gone, and frees the bytes", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "remnant-sweep-"));
    const s = new FileShareStore(fresh);
    try {
      const orphan = newShareId();
      const live = newShareId();

      for (const [id, size] of [[orphan, 4096], [live, 1024]] as const) {
        await s.put({
          id,
          ciphertext: new Uint8Array(size),
          size,
          ttlMs: 60_000,
          maxClaims: 1,
          manageTokenHash: await hashToken(newManageToken()),
        });
      }

      // Simulate the leak the hosted store actually suffers: Redis expires the
      // metadata on its own and the ciphertext is left with nothing pointing
      // at it.
      await rm(path.join(fresh, `${orphan}.json`), { force: true });

      const result = await s.sweep(0);
      expect(result.scanned).toBe(2);
      expect(result.deleted).toBe(1);
      expect(result.freed).toBe(4096);

      // The live share is untouched.
      expect(await s.stat(live)).not.toBeNull();
      expect((await s.usage()).bytes).toBe(1024);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("sweeps expired shares but spares live ones", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "remnant-expiry-"));
    const s = new FileShareStore(fresh);
    try {
      const expired = newShareId();
      const live = newShareId();

      await s.put({
        id: expired,
        ciphertext: new Uint8Array(2048),
        size: 2048,
        ttlMs: -1,
        maxClaims: 1,
        manageTokenHash: await hashToken(newManageToken()),
      });
      await s.put({
        id: live,
        ciphertext: new Uint8Array(256),
        size: 256,
        ttlMs: 60_000,
        maxClaims: 1,
        manageTokenHash: await hashToken(newManageToken()),
      });

      const result = await s.sweep(0);
      expect(result.deleted).toBe(1);
      expect(result.freed).toBe(2048);
      expect(await s.stat(live)).not.toBeNull();
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("leaves very recent objects alone, so a live upload is never swept", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "remnant-grace-"));
    const s = new FileShareStore(fresh);
    try {
      const id = newShareId();
      await s.put({
        id,
        ciphertext: new Uint8Array(128),
        size: 128,
        ttlMs: -1, // expired, so only the grace period protects it
        maxClaims: 1,
        manageTokenHash: await hashToken(newManageToken()),
      });

      const result = await s.sweep(60_000);
      expect(result.deleted).toBe(0);
      expect((await s.usage()).bytes).toBe(128);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("share end to end", () => {
  it("encrypt → store → claim → decrypt, with the server never seeing the key", async () => {
    const id = newShareId();
    const original = "coordinates: 12.9716, 79.1588";
    const { ciphertext, fragment } = await encryptForShare(
      new Blob([original], { type: "text/plain" }),
      "location.txt",
      id,
    );

    await store.put({
      id,
      ciphertext,
      size: ciphertext.length,
      ttlMs: 60_000,
      maxClaims: 1,
      manageTokenHash: await hashToken(newManageToken()),
    });

    // Everything the operator can see: an opaque id and a padded length.
    const record = await store.stat(id);
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain("location.txt");
    expect(Buffer.from(ciphertext).toString("latin1")).not.toContain("12.9716");

    const claimed = await store.claim(id);
    const out = await decryptShare(claimed!.ciphertext, fragment, id);
    expect(await out.blob.text()).toBe(original);
    expect(out.name).toBe("location.txt");

    expect(await store.claim(id)).toBeNull();
  });
});
