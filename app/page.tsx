import Link from "next/link";

export default function Home() {
  return (
    <main className="wrap">
      <p className="eyebrow">Hackulus 2026 · Cybersecurity</p>
      <h1>Remnant</h1>
      <p className="lede">What your files still carry after you think you cleaned them.</p>
      <p className="sub">
        Stripping metadata is a solved problem and your phone already does the easy half. This
        looks for what the strippers miss: the second full-resolution image hidden inside a
        photo, the video appended after the end marker, the page-one thumbnail inside a
        document. Then it re-reads its own output and shows you the proof.
      </p>

      <div className="panel">
        <div className="panel-title">
          <h2>Inspect and clean</h2>
          <span className="meta">no upload · no account</span>
        </div>
        <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13.5 }}>
          Read everything a file discloses, surface the payload nothing renders, strip it
          losslessly, then re-read the output and see the result. That claim is enforced rather
          than asserted: this route ships{" "}
          <code style={{ fontFamily: "var(--mono)" }}>connect-src &apos;none&apos;</code>, so the
          browser itself refuses any outbound request the page attempts. Open your Network tab
          and watch.
        </p>
        <div className="actions">
          <Link href="/tool" prefetch={false}>
            <button className="primary">Inspect a file</button>
          </Link>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h2>Forge</h2>
          <span className="meta">also sealed off the network</span>
        </div>
        <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13.5 }}>
          Write make, model, capture time and GPS onto a clean file, then score the result for
          contradictions — a capture date before the camera shipped, a longitude that disagrees
          with the clock. The same rules run in reverse on a file somebody sent you.
        </p>
        <div className="actions">
          <Link href="/forge" prefetch={false}>
            <button>Open forge</button>
          </Link>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h2>Share</h2>
          <span className="meta">ciphertext only</span>
        </div>
        <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13.5 }}>
          Encrypted in your browser before upload, with the key carried in the link after the{" "}
          <code style={{ fontFamily: "var(--mono)" }}>#</code> — which browsers never put in a
          request. Links expire, can be claimed a set number of times, and you can revoke any of
          them from your own device.
        </p>
        <div className="actions">
          <Link href="/share" prefetch={false}>
            <button>Open share</button>
          </Link>
        </div>
      </div>
    </main>
  );
}
