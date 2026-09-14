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
          <h2>Open the tool</h2>
          <span className="meta">no upload · no account</span>
        </div>
        <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13.5 }}>
          Files are read in your browser and never sent anywhere. That is not a promise in the
          copy — the tool route ships a Content-Security-Policy of{" "}
          <code style={{ fontFamily: "var(--mono)" }}>connect-src &apos;none&apos;</code>, so the
          browser itself refuses any outbound request the page attempts. Open your Network tab
          and watch.
        </p>
        <div className="actions">
          <Link href="/tool">
            <button className="primary">Inspect a file</button>
          </Link>
        </div>
      </div>
    </main>
  );
}
