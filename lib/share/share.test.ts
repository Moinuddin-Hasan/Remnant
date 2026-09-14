import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decryptShare, encryptForShare, MAX_PLAINTEXT } from "./crypto";
import { FileShareStore, newShareId } from "./store";

const dir = await mkdtemp(path.join(tmpdir(), "remnant-share-"));
const store = new FileShareStore(dir);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fileOf = (text: string, name = "secret.txt") =>
  ({ blob: new Blob([text], { type: "text/plain" }), name });

describe("share crypto", () => {
  it("round-trips a file through encrypt and decrypt", async () => {
    const { blob, name } = fileOf("the quick brown fox");
    const id = newShareId();
    const { ciphertext, fragment } = await encryptForShare(blob, name, id);

    const out = await decryptShare(ciphertext, fragment, id);
    expect(out.name).toBe(name);
    expect(out.type).toBe("text/plain");
    expect(await out.blob.text()).toBe("the quick brown fox");
  });

  it("hides the filename and MIME type inside the ciphertext", async () => {
    const { blob } = fileOf("payload", "resume-final.pdf");
    const id = newShareId();
    const { ciphertext } = await encryptForShare(blob, "resume-final.pdf", id);

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
    await expect(decryptShare(ciphertext, fragment, newShareId())).rejects.toThrow(
      /Decryption failed/,
    );
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
    await store.put(id, new Uint8Array([1, 2, 3]), 60_000, 1);

    expect((await store.stat(id))?.remaining).toBe(1);
    expect((await store.stat(id))?.remaining).toBe(1);

    const claimed = await store.claim(id);
    expect(claimed).not.toBeNull();
    expect(Array.from(claimed!.ciphertext)).toEqual([1, 2, 3]);
  });

  it("burns after the last claim", async () => {
    const id = newShareId();
    await store.put(id, new Uint8Array([9]), 60_000, 1);
    expect(await store.claim(id)).not.toBeNull();
    expect(await store.claim(id)).toBeNull();
    expect(await store.stat(id)).toBeNull();
  });

  it("serialises concurrent claims so the cap cannot be exceeded", async () => {
    const id = newShareId();
    await store.put(id, new Uint8Array([7]), 60_000, 1);

    // Both fire before either finishes — the TOCTOU case a naive
    // read-then-write counter loses.
    const results = await Promise.all([store.claim(id), store.claim(id), store.claim(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("honours a claim cap above one", async () => {
    const id = newShareId();
    await store.put(id, new Uint8Array([5]), 60_000, 3);
    const results = await Promise.all([
      store.claim(id), store.claim(id), store.claim(id), store.claim(id), store.claim(id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it("expires by TTL", async () => {
    const id = newShareId();
    await store.put(id, new Uint8Array([1]), -1, 5); // already expired
    expect(await store.stat(id)).toBeNull();
    expect(await store.claim(id)).toBeNull();
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

    await store.put(id, ciphertext, 60_000, 1);

    // What the operator can see on disk: opaque bytes and a length bucket.
    const record = await store.stat(id);
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain("location.txt");
    expect(Buffer.from(ciphertext).toString("latin1")).not.toContain("12.9716");

    const claimed = await store.claim(id);
    const out = await decryptShare(claimed!.ciphertext, fragment, id);
    expect(await out.blob.text()).toBe(original);
    expect(out.name).toBe("location.txt");

    // And the link is now dead.
    expect(await store.claim(id)).toBeNull();
  });
});
