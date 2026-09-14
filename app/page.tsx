import Link from "next/link";

const FUNCTIONS = [
  {
    href: "/tool",
    label: "Inspect & clean",
    lead: "See what a file discloses, then remove it losslessly.",
    body:
      "Every finding is named with the exact byte range it came from. The strip keeps only the markers a decoder needs, so the compressed image data is never touched and the pixels come out identical. Then the output is re-read with the same engine that read the original — nothing prints “clean” off the back of a write.",
    points: [
      "EXIF, XMP, IPTC, ICC, comments, and the payload nothing renders",
      "A second full-resolution image hidden in APP2 MPF",
      "The video some phones append after the end-of-image marker",
      "Formats we cannot rewrite safely are reported, never silently altered",
    ],
  },
  {
    href: "/forge",
    label: "Forge",
    lead: "Write a new identity onto a file, then see where it argues with itself.",
    body:
      "Make, model, capture time, timezone, GPS and artist are written as a real EXIF block through the same patch engine the stripper uses — one write path, one failure mode. The file is then read back and scored, because a writer that reports success without re-parsing its own output is how you end up with a file no reader accepts.",
    points: [
      "Existing metadata is removed first, so nothing contradicts the new block",
      "GPS checked against the recorded timezone offset",
      "Capture date checked against 82 known camera release dates",
      "Every contradiction says when it also happens innocently",
    ],
  },
  {
    href: "/share",
    label: "Share",
    lead: "Send a file without handing it to the platform.",
    body:
      "Encrypted in the browser with AES-256-GCM before anything is uploaded. The key travels after the # in the link, which browsers never put in a request, so the server stores ciphertext it has no key for. The filename and type live inside the ciphertext too — the operator never learns them.",
    points: [
      "Links expire, and can be claimed a set number of times",
      "Opening the page does not consume a claim, so previews cannot burn it",
      "Revoke any link from your own device, at any moment",
      "Your dashboard knows the filename; the server does not",
    ],
  },
] as const;

const LAYERS = [
  {
    name: "File metadata",
    status: "Handled",
    cls: "handled",
    body: "EXIF, XMP, IPTC, ICC, container comments, and embedded payload. Removed here, and verified afterwards.",
  },
  {
    name: "Transport metadata",
    status: "Out of reach",
    cls: "out",
    body: "Upload IP, the account a platform binds your file to, timestamps, sender to recipient. Created after this tool runs.",
  },
  {
    name: "Content",
    status: "Out of scope",
    cls: "out",
    body: "The street sign in frame, the reflection in a window, the sensor noise that identifies one physical camera.",
  },
] as const;

export default function Home() {
  return (
    <main className="container page">
      <p className="t-label">Metadata disclosure</p>
      <h1 className="t-display">
        What your files still carry
        <br />
        after you think you cleaned them.
      </h1>
      <p className="lede prose">
        Stripping metadata is a solved problem, and your phone already does the easy half. This
        looks for what the strippers miss, writes metadata as precisely as it removes it, and
        sends a file without handing it to anyone.
      </p>

      <div className="actions" style={{ marginBottom: "var(--space-6)" }}>
        <Link href="/tool" className="btn btn-primary" prefetch={false}>
          Inspect a file
        </Link>
        <Link href="/share" className="btn" prefetch={false}>
          Share one privately
        </Link>
      </div>

      {FUNCTIONS.map((f) => (
        <section className="card" key={f.href}>
          <div className="card-head">
            <h2 className="t-headline-md">{f.label}</h2>
            <Link href={f.href} className="meta" prefetch={false}>
              open →
            </Link>
          </div>
          <p className="t-body-lg prose" style={{ margin: "0 0 var(--space-1)" }}>
            {f.lead}
          </p>
          <p className="t-body dim prose" style={{ marginTop: 0 }}>
            {f.body}
          </p>
          <ul className="list" style={{ marginTop: "var(--space-2)" }}>
            {f.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      ))}

      <section className="card">
        <div className="card-head">
          <h2 className="t-headline-md">Three layers, and what a browser can reach</h2>
          <span className="meta">one of three</span>
        </div>
        <div className="grid">
          {LAYERS.map((l) => (
            <div className={`well field ${l.cls}`} key={l.name}>
              <span className="status">{l.status}</span>
              <h3>{l.name}</h3>
              <p>{l.body}</p>
            </div>
          ))}
        </div>
        <p className="note">
          Taxonomy follows the privacy-tooling literature rather than being ours. Naming the two
          layers we cannot reach is what keeps the first one honest.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="t-headline-md">The claim, enforced rather than promised</h2>
          <span className="meta">connect-src &apos;none&apos;</span>
        </div>
        <p className="t-body prose" style={{ marginTop: 0 }}>
          Inspect and Forge ship a Content-Security-Policy that forbids the page from making any
          outbound request at all. Not a policy we follow — a rule the browser enforces against
          us, including against any dependency we did not write. Open the Network tab and watch
          nothing happen.
        </p>
      </section>
    </main>
  );
}
