import { NextResponse } from "next/server";
import { shareStore, storageMode } from "@/lib/share/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" } as const;

/** Current occupancy, for the dashboard's quota bar. */
export async function GET(): Promise<NextResponse> {
  try {
    const usage = await shareStore().usage();
    return NextResponse.json({ ...usage, mode: storageMode() }, { headers: noStore });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read storage usage." },
      { status: 500, headers: noStore },
    );
  }
}

/**
 * Reclaims orphaned ciphertext.
 *
 * Runs opportunistically when the store approaches its quota, but is exposed
 * manually too — on a 256 MB tier you want to be able to clear the decks
 * before a demo rather than discovering the problem during one.
 *
 * Gated by the same passphrase as uploads where one is configured, since an
 * open sweep endpoint is a free denial-of-service against live shares that
 * happen to be past their grace period.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const expected = process.env.REMNANT_SHARE_PASSPHRASE;
  if (expected && request.headers.get("x-remnant-passphrase") !== expected) {
    return NextResponse.json({ error: "Wrong or missing passphrase." }, { status: 403, headers: noStore });
  }

  try {
    const store = shareStore();
    const result = await store.sweep();
    const usage = await store.usage();
    return NextResponse.json({ ...result, usage }, { headers: noStore });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sweep failed." },
      { status: 500, headers: noStore },
    );
  }
}
