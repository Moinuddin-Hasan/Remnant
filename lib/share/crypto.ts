/**
 * Client-side encryption for share links.
 *
 * The key is generated in the browser, never transmitted, and travels to the
 * recipient after the `#` in the URL. Browsers do not put a fragment in an
 * HTTP request, so the server stores ciphertext it has no key for.
 *
 * Three details that are easy to get wrong and each defeat the point:
 *
 *   1. The filename and MIME type go INSIDE the ciphertext. Storing them
 *      alongside would hand the operator "resume.pdf, 412,882 bytes", which is
 *      often the entire secret.
 *   2. Ciphertext length is padded. AES-GCM is length-preserving, so an exact
 *      byte count fingerprints a file against a candidate corpus.
 *   3. The share id is bound in as additional authenticated data, so a
 *      ciphertext cannot be moved to a different id and still decrypt.
 */

const PAD_BLOCK = 64 * 1024;
const IV_BYTES = 12;
const KEY_BITS = 256;

export const MAX_PLAINTEXT = 25 * 1024 * 1024;

export interface EncryptedShare {
  readonly ciphertext: Uint8Array;
  /** Goes after the `#`. Never sent to a server. */
  readonly fragment: string;
  readonly paddedSize: number;
}

export interface DecryptedShare {
  readonly blob: Blob;
  readonly name: string;
  readonly type: string;
}

interface Header {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(
      "Web Crypto is unavailable. This page must be served over HTTPS or from localhost — " +
        "a plain-http LAN address does not count as a secure context.",
    );
  }
  return c.subtle;
};

export const b64url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const unb64url = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin =
    typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const padTo = (n: number): number => Math.ceil(Math.max(n, 1) / PAD_BLOCK) * PAD_BLOCK;

/**
 * Returned as a plain ArrayBuffer rather than a view: TypeScript 5.7 narrowed
 * `Uint8Array` to carry its buffer type, and `BufferSource` will not accept an
 * `ArrayBufferLike`-backed view.
 */
const buf = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

const aad = (id: string): ArrayBuffer => buf(new TextEncoder().encode(`remnant:${id}`));

export async function encryptForShare(
  file: Blob,
  filename: string,
  id: string,
): Promise<EncryptedShare> {
  if (file.size > MAX_PLAINTEXT) {
    throw new Error(`File exceeds the ${MAX_PLAINTEXT / 1024 / 1024} MB share limit.`);
  }

  const header: Header = { name: filename, type: file.type || "application/octet-stream", size: file.size };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const body = new Uint8Array(await file.arrayBuffer());

  const unpadded = 4 + headerBytes.length + body.length;
  const plaintext = new Uint8Array(padTo(unpadded)); // zero-filled tail is the padding
  new DataView(plaintext.buffer).setUint32(0, headerBytes.length);
  plaintext.set(headerBytes, 4);
  plaintext.set(body, 4 + headerBytes.length);

  const key = await subtle().generateKey({ name: "AES-GCM", length: KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const cipherBuf = await subtle().encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: aad(id) },
    key,
    buf(plaintext),
  );
  const raw = new Uint8Array(await subtle().exportKey("raw", key));

  return {
    ciphertext: new Uint8Array(cipherBuf),
    fragment: `${b64url(raw)}.${b64url(iv)}`,
    paddedSize: plaintext.length,
  };
}

export async function decryptShare(
  ciphertext: Uint8Array,
  fragment: string,
  id: string,
): Promise<DecryptedShare> {
  const [keyPart, ivPart] = fragment.replace(/^#/, "").split(".");
  if (!keyPart || !ivPart) throw new Error("This link is missing its decryption key.");

  const key = await subtle().importKey("raw", buf(unb64url(keyPart)), { name: "AES-GCM" }, false, [
    "decrypt",
  ]);

  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await subtle().decrypt(
      { name: "AES-GCM", iv: buf(unb64url(ivPart)), additionalData: aad(id) },
      key,
      buf(ciphertext),
    );
  } catch {
    throw new Error("Decryption failed — the link is wrong, or the file was tampered with.");
  }

  const plain = new Uint8Array(plainBuf);
  const headerLength = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
  if (headerLength <= 0 || headerLength > plain.length - 4) {
    throw new Error("Decrypted payload is malformed.");
  }

  const header = JSON.parse(
    new TextDecoder().decode(plain.subarray(4, 4 + headerLength)),
  ) as Header;

  const start = 4 + headerLength;
  const body = plain.subarray(start, start + header.size); // padding lies past this
  return {
    blob: new Blob([body.slice().buffer as ArrayBuffer], { type: header.type }),
    name: header.name,
    type: header.type,
  };
}
