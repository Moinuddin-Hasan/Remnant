import ClaimGate from "@/components/share/ClaimGate";

export const dynamic = "force-dynamic";

/**
 * The claim page is a thin shell: everything that matters happens client-side,
 * because the decryption key lives in the URL fragment and the server is never
 * sent it.
 */
export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="container page">
      <p className="t-label">Remnant</p>
      <h1>Shared with you</h1>
      <p className="lede">
        Encrypted before it was uploaded. The key is in the link, not on the server.
      </p>
      <ClaimGate id={id} />
    </main>
  );
}
