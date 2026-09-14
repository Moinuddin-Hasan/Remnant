import { NextResponse } from "next/server";
import { shareStore } from "@/lib/share/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^[0-9a-f]{32}$/;

const noStore = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
} as const;

/**
 * HEAD / GET report whether a link is still live WITHOUT consuming it.
 *
 * This is what makes the claim gate work. A link-preview crawler issues a GET
 * within seconds of the URL being pasted into a chat, and if that GET burned
 * the download the recipient would always find a dead link. Bytes are only
 * ever served from POST, which a crawler does not issue.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });

  const record = await shareStore().stat(id);
  if (!record) {
    return NextResponse.json({ error: "This link has expired or been used." }, { status: 404, headers: noStore });
  }

  return NextResponse.json(
    { id: record.id, size: record.size, expiresAt: record.expiresAt, remaining: record.remaining },
    { headers: noStore },
  );
}

/**
 * Consumes one claim and returns the ciphertext.
 *
 * Burn happens on CLAIM, not on bytes delivered. The server can never confirm
 * the client received the last byte — that is the Two Generals problem, not an
 * implementation gap — so the honest semantic is "this link can be claimed
 * once" rather than "read exactly once".
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });

  const claimed = await shareStore().claim(id);
  if (!claimed) {
    return NextResponse.json({ error: "This link has expired or been used." }, { status: 404, headers: noStore });
  }

  return new NextResponse(claimed.ciphertext.slice().buffer as ArrayBuffer, {
    headers: {
      ...noStore,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment",
      "X-Remnant-Remaining": String(claimed.record.remaining),
    },
  });
}
