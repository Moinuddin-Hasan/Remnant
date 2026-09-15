import Link from "next/link";

const FEATURES = [
  {
    href: "/tool",
    n: "01",
    label: "Inspect & clean",
    lead: "See everything a file discloses, then remove it without touching the picture.",
    points: [
      ["Reads the lot", "EXIF, XMP, IPTC, ICC, comments and container fields, each named with the exact byte range it came from."],
      ["Finds what viewers hide", "A second full-resolution image tucked into APP2 MPF. A Motion Photo video appended past the end-of-image marker. Both rendered on screen."],
      ["Strips losslessly", "Keeps only the markers a decoder needs, so the compressed image data is never rewritten and the pixels come out identical."],
      ["Proves it", "Re-reads the file it produced with the same engine, and shows you the result and the byte count removed."],
    ],
    formats: "JPEG · PNG · WebP · HEIC · AVIF · MP4 · MOV",
  },
  {
    href: "/forge",
    n: "02",
    label: "Forge",
    lead: "Write a new identity onto a file, and find out whether it holds together.",
    points: [
      ["Writes real EXIF", "Make, model, software, artist, capture time, timezone offset and GPS, as a proper TIFF block — not a text tag a reader will ignore."],
      ["Clears the ground first", "Existing metadata and embedded payload are removed before the new block goes in, so nothing contradicts it."],
      ["Scores the result", "GPS against the recorded timezone, capture date against 82 known camera release dates, model against manufacturer."],
      ["Reads back what it made", "The score runs on the produced file, not on the values you typed."],
    ],
    formats: "JPEG · PNG · WebP",
  },
  {
    href: "/share",
    n: "03",
    label: "Share",
    lead: "Send a file as a link the platform never sees the contents of.",
    points: [
      ["Encrypts before upload", "AES-256-GCM in your browser. The key rides after the # in the link, which browsers never put in a request."],
      ["Hides the envelope too", "Filename and type are sealed inside the ciphertext, and the length is padded, so the store holds an opaque object."],
      ["Expires and burns", "Set how long a link lives and how many times it can be claimed. Opening the page costs nothing — only claiming does."],
      ["Stays yours", "Your dashboard lists every link you made, with the filename, and revokes any of them instantly."],
    ],
    formats: "any file, up to 100 MB",
  },
] as const;

export default function Home() {
  return (
    <main className="container page">
      <section className="hero">
        <p className="t-label">Metadata toolkit</p>
        <h1 className="t-display">
          Files say more
          <br />
          than you meant them to.
        </h1>
        <p className="hero-lede">
          Remnant reads what a file is really carrying, removes it, writes it, or sends it
          somewhere private — all inside your browser. Drag a photo in and you will see the
          coordinates of the room it was taken in, the serial number of the camera body, and the
          second image most viewers never show you.
        </p>
        <div className="actions">
          <Link href="/tool" className="btn btn-primary" prefetch={false}>
            Inspect a file
          </Link>
          <Link href="/share" className="btn" prefetch={false}>
            Send one privately
          </Link>
        </div>
        <div className="hero-stats">
          <span><strong>7</strong> formats</span>
          <span><strong>82</strong> camera profiles</span>
          <span><strong>0</strong> uploads to read a file</span>
        </div>
      </section>

      <div className="feature-grid">
        {FEATURES.map((f) => (
          <section className="card feature" key={f.href}>
            <div className="feature-head">
              <span className="feature-n">{f.n}</span>
              <h2 className="t-headline-md">{f.label}</h2>
            </div>
            <p className="feature-lead">{f.lead}</p>
            <dl className="feature-points">
              {f.points.map(([term, detail]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{detail}</dd>
                </div>
              ))}
            </dl>
            <div className="feature-foot">
              <span className="meta">{f.formats}</span>
              <Link href={f.href} className="feature-go" prefetch={false}>
                Open {f.label} →
              </Link>
            </div>
          </section>
        ))}
      </div>

      <section className="card band">
        <div>
          <h2 className="t-headline-md">Your files stay on your machine</h2>
          <p className="t-body dim" style={{ marginTop: 8, marginBottom: 0 }}>
            Inspect and Forge run entirely in the browser tab, and the pages ship a
            Content-Security-Policy that forbids them from making any outbound request — a rule
            the browser enforces, not a promise we make. Open the Network tab and watch nothing
            happen.
          </p>
        </div>
        <code className="band-code">connect-src &apos;none&apos;</code>
      </section>
    </main>
  );
}
