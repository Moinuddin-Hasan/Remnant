/**
 * Live storage check. Run: node --env-file=.env.local scripts/check-storage.mjs
 *
 * Verifies the two things the share flow depends on and that are impossible to
 * test against the filesystem backend: that Redis DECR is genuinely atomic on
 * the real instance, and that a deleted blob is actually gone rather than
 * merely dereferenced.
 */
import { Redis } from "@upstash/redis";
import { del, get, head, list, put } from "@vercel/blob";

const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => {
  console.log(`  FAIL  ${m}`);
  process.exitCode = 1;
};

async function checkRedis() {
  console.log("\nRedis (Upstash)");
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return bad("credentials absent");

  const r = new Redis({ url, token });
  const key = `remnant:selftest:${Date.now()}`;

  try {
    const t0 = Date.now();
    await r.set(key, { hello: "world" }, { ex: 60 });
    const round = Date.now() - t0;
    const got = await r.get(key);
    if (got?.hello === "world") ok(`set/get round trip (${round} ms)`);
    else return bad(`get returned ${JSON.stringify(got)}`);

    // NX must refuse to clobber, or a guessed id could hijack a live share.
    const second = await r.set(key, { hello: "other" }, { ex: 60, nx: true });
    if (second === null) ok("set NX refuses to overwrite an existing key");
    else bad("set NX overwrote an existing key");

    // The atomic claim. Ten concurrent DECRs from a counter of 3 must yield
    // exactly 3 non-negative results.
    const counter = `${key}:count`;
    await r.set(counter, 3, { ex: 60 });
    const results = await Promise.all(Array.from({ length: 10 }, () => r.decr(counter)));
    const winners = results.filter((n) => n >= 0).length;
    if (winners === 3) ok("DECR is atomic under 10 concurrent claims (exactly 3 won)");
    else bad(`expected 3 winners under concurrency, got ${winners} — [${results.join(", ")}]`);

    await r.del(key, counter);
    if ((await r.get(key)) === null) ok("delete removes the key");
    else bad("key survived deletion");
  } catch (err) {
    bad(`threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkBlob() {
  console.log("\nBlob");
  // Two valid credentials: a static read-write token, or OIDC (the platform
  // injects VERCEL_OIDC_TOKEN and the project carries BLOB_STORE_ID).
  const rw = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const oidc = Boolean(process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN);
  if (!rw && !oidc) {
    return bad("no Blob credential — need BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID + VERCEL_OIDC_TOKEN");
  }
  ok(`authenticating via ${rw ? "read-write token" : "OIDC"}`);

  const pathname = `shares/selftest-${Date.now()}.bin`;
  const payload = new Uint8Array([1, 2, 3, 4, 5]);

  try {
    const uploaded = await put(pathname, Buffer.from(payload), {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/octet-stream",
    });
    ok(`upload (${uploaded.url.slice(0, 60)}…)`);

    const info = await head(uploaded.url);
    if (info.size === payload.length) ok(`head reports the right size (${info.size} bytes)`);
    else bad(`head size ${info.size}, expected ${payload.length}`);

    const found = await get(pathname, { access: "private", useCache: false });
    const fetched = new Uint8Array(await new Response(found.stream).arrayBuffer());
    if (Buffer.compare(Buffer.from(fetched), Buffer.from(payload)) === 0) ok("authenticated read returns the right bytes");
    else bad("authenticated read returned different bytes");

    const anonymous = await fetch(uploaded.url, { cache: "no-store" }).then((r) => r.status).catch(() => 0);
    if (anonymous !== 200) ok(`an unauthenticated fetch of the blob URL is refused (${anonymous})`);
    else bad("the blob URL is publicly fetchable — the burn would be unenforceable");

    // The part that matters for a 256 MB quota: is it really gone?
    await del(uploaded.url);
    const after = await head(uploaded.url).catch(() => null);
    if (after === null) ok("delete actually removes the object (head 404s afterwards)");
    else bad(`object still present after delete: ${after.size} bytes`);

    const listed = await list({ prefix: "shares/" });
    const total = listed.blobs.reduce((n, b) => n + b.size, 0);
    ok(`store holds ${listed.blobs.length} share object(s), ${(total / 1048576).toFixed(2)} MB`);
    if (listed.blobs.some((b) => b.pathname === pathname)) {
      bad("the deleted object is still listed");
    }
  } catch (err) {
    bad(`threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await checkRedis();
await checkBlob();
console.log(process.exitCode ? "\nSTORAGE CHECK FAILED\n" : "\nSTORAGE OK\n");
