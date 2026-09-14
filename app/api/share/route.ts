import { NextResponse } from "next/server";
import { MAX_CIPHERTEXT, newShareId, shareStore, DEFAULT_TTL_MS } from "@/lib/share/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accepts ciphertext and returns an id.
 *
 * The body is raw encrypted bytes and nothing else — no filename, no MIME
 * type, no hash. Those live inside the ciphertext, so this endpoint cannot
 * learn them even if it wanted to.
 *
 * On a serverless host this becomes a presigned-upload handshake so the
 * function never touches file bytes at all; the filesystem store is the
 * self-host path and takes the bytes directly.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_CIPHERTEXT) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0) {
    return NextResponse.json({ error: "Empty body." }, { status: 400 });
  }
  if (body.length > MAX_CIPHERTEXT) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }

  const ttlMs = Number(request.headers.get("x-remnant-ttl") ?? DEFAULT_TTL_MS);
  const maxClaims = Number(request.headers.get("x-remnant-claims") ?? 1);

  const id = newShareId();
  const record = await shareStore().put(
    id,
    body,
    Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, DEFAULT_TTL_MS * 24) : DEFAULT_TTL_MS,
    Number.isFinite(maxClaims) && maxClaims > 0 ? Math.min(maxClaims, 20) : 1,
  );

  return NextResponse.json(
    { id: record.id, expiresAt: record.expiresAt, remaining: record.remaining },
    { headers: { "Cache-Control": "no-store" } },
  );
}
