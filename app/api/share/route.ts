import { NextResponse } from "next/server";
import { SHARE_ID } from "@/lib/share/id";
import { shareStore, storageMode } from "@/lib/share/store";
import {
  DEFAULT_MAX_CLAIMS,
  DEFAULT_TTL_MS,
  MAX_CIPHERTEXT,
  MAX_CLAIMS,
  MAX_TTL_MS,
} from "@/lib/share/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" } as const;

/**
 * Tells the browser which backend it is talking to, so it knows whether to
 * upload direct to Blob or post ciphertext inline. Deliberately reveals
 * nothing beyond that and whether a passphrase is required.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      mode: storageMode(),
      maxBytes: MAX_CIPHERTEXT,
      passphraseRequired: Boolean(process.env.REMNANT_SHARE_PASSPHRASE),
      defaultTtlMs: DEFAULT_TTL_MS,
      maxTtlMs: MAX_TTL_MS,
      maxClaims: MAX_CLAIMS,
    },
    { headers: noStore },
  );
}

interface RegisterBody {
  readonly id?: string;
  readonly blobUrl?: string;
  /** base64 ciphertext, local mode only — hosted uploads go direct to Blob. */
  readonly ciphertext?: string;
  readonly size?: number;
  readonly ttlMs?: number;
  readonly maxClaims?: number;
  readonly manageTokenHash?: string;
  readonly passphrase?: string;
}

const clamp = (v: number | undefined, fallback: number, max: number): number =>
  Number.isFinite(v) && (v as number) > 0 ? Math.min(v as number, max) : fallback;

/**
 * Registers a share.
 *
 * Hosted: the browser has already uploaded ciphertext to Blob, so this records
 * the metadata and the claim counter. Local: the ciphertext comes in the body,
 * because there is no Blob to upload to.
 *
 * Either way the server receives an id, a size and a token hash — no filename,
 * no MIME type, no key.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400, headers: noStore });
  }

  const expected = process.env.REMNANT_SHARE_PASSPHRASE;
  if (expected && body.passphrase !== expected) {
    return NextResponse.json({ error: "Wrong or missing passphrase." }, { status: 403, headers: noStore });
  }

  if (!body.id || !SHARE_ID.test(body.id)) {
    return NextResponse.json({ error: "Malformed share id." }, { status: 400, headers: noStore });
  }
  if (!body.manageTokenHash || !/^[0-9a-f]{64}$/.test(body.manageTokenHash)) {
    return NextResponse.json({ error: "Malformed manage token." }, { status: 400, headers: noStore });
  }

  const ttlMs = clamp(body.ttlMs, DEFAULT_TTL_MS, MAX_TTL_MS);
  const maxClaims = clamp(body.maxClaims, DEFAULT_MAX_CLAIMS, MAX_CLAIMS);

  try {
    let ciphertext: Uint8Array | undefined;
    if (body.ciphertext) {
      ciphertext = new Uint8Array(Buffer.from(body.ciphertext, "base64"));
      if (ciphertext.length > MAX_CIPHERTEXT) {
        return NextResponse.json({ error: "Too large." }, { status: 413, headers: noStore });
      }
    }

    const record = await shareStore().put({
      id: body.id,
      ciphertext,
      blobUrl: body.blobUrl,
      size: ciphertext?.length ?? body.size ?? 0,
      ttlMs,
      maxClaims,
      manageTokenHash: body.manageTokenHash,
    });

    return NextResponse.json({ ...record, mode: storageMode() }, { headers: noStore });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not create the share." },
      { status: 400, headers: noStore },
    );
  }
}
