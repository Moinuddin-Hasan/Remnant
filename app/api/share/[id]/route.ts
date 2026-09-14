import { NextResponse } from "next/server";
import { SHARE_ID } from "@/lib/share/id";
import { shareStore } from "@/lib/share/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
} as const;

const gone = () =>
  NextResponse.json(
    { error: "This link has expired, been used, or been revoked." },
    { status: 404, headers: noStore },
  );

/**
 * Reports whether a link is live WITHOUT consuming it.
 *
 * This is what makes the claim gate work. A link-preview crawler issues a GET
 * within seconds of a URL being pasted into a chat; if that GET burned the
 * share, the recipient would always find a dead link. Bytes come only from
 * POST, which crawlers do not send.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!SHARE_ID.test(id)) return gone();

  const record = await shareStore().stat(id);
  if (!record) return gone();

  return NextResponse.json(
    { id: record.id, size: record.size, expiresAt: record.expiresAt, remaining: record.remaining },
    { headers: noStore },
  );
}

/**
 * Consumes one claim and returns the ciphertext.
 *
 * The burn happens on CLAIM, not on bytes delivered. A server can never
 * confirm the client received the final byte — that is the Two Generals
 * problem, not an implementation gap — so the honest semantic is "this link
 * can be claimed once", which is what the UI says.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!SHARE_ID.test(id)) return gone();

  const claimed = await shareStore().claim(id);
  if (!claimed) return gone();

  return new NextResponse(claimed.ciphertext.slice().buffer as ArrayBuffer, {
    headers: {
      ...noStore,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment",
      "X-Remnant-Remaining": String(claimed.record.remaining),
    },
  });
}

/**
 * Revocation from the creator's dashboard.
 *
 * Authorised by a token only the creator's browser holds; the server stores
 * its SHA-256 and never the token itself. This is what lets you kill a link
 * between one judge and the next without waiting for a TTL.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!SHARE_ID.test(id)) return gone();

  const token = request.headers.get("x-remnant-manage") ?? "";
  if (!token) {
    return NextResponse.json({ error: "Missing manage token." }, { status: 401, headers: noStore });
  }

  const ok = await shareStore().revoke(id, token);
  if (!ok) {
    return NextResponse.json({ error: "Not revocable." }, { status: 403, headers: noStore });
  }
  return NextResponse.json({ revoked: true }, { headers: noStore });
}
