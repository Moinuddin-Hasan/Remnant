import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { SHARE_ID } from "@/lib/share/id";
import { MAX_CIPHERTEXT } from "@/lib/share/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a short-lived token so the browser can PUT ciphertext straight to
 * Blob storage.
 *
 * This exists because Vercel caps request bodies at 4.5 MB, which one phone
 * video exceeds several times over. Routing uploads through a function would
 * cap the whole product at a size nobody would find useful. It also means the
 * function never touches the bytes at all, which is the property we actually
 * want to be able to claim.
 *
 * The passphrase gate is what keeps this from being an open file host — the
 * difference between a demo and an abuse vector.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const expected = process.env.REMNANT_SHARE_PASSPHRASE;
        if (expected) {
          let supplied: string | undefined;
          try {
            supplied = (JSON.parse(clientPayload ?? "{}") as { passphrase?: string }).passphrase;
          } catch {
            supplied = undefined;
          }
          if (supplied !== expected) throw new Error("Wrong or missing passphrase.");
        }

        const id = pathname.replace(/^shares\//, "").replace(/\.bin$/, "");
        if (!SHARE_ID.test(id)) throw new Error("Malformed share id.");

        return {
          // Ciphertext only. A wider list would let this endpoint be used to
          // host arbitrary content types under our origin.
          allowedContentTypes: ["application/octet-stream"],
          maximumSizeInBytes: MAX_CIPHERTEXT,
          // The id is chosen by the client before encryption because it is
          // bound into the ciphertext as AAD; a random suffix would break that.
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ id }),
        };
      },
      onUploadCompleted: async () => {
        // Registration is a separate, authenticated step. Nothing to do here,
        // and an unregistered blob simply expires unreferenced.
      },
    });

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload rejected." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
