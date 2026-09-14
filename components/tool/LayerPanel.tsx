"use client";

/**
 * The honesty panel. Naming what the tool cannot reach is what separates this
 * from a stripper that implies a clean file is an anonymous one.
 *
 * Taxonomy follows the privacy-tooling literature (AnarSec, Whonix); it is not
 * ours and is not presented as ours.
 */
const LAYERS = [
  {
    name: "File metadata",
    status: "Handled",
    cls: "handled",
    body: "EXIF, XMP, IPTC, ICC, comments — and the embedded payload above. Removed and verified here.",
  },
  {
    name: "Transport metadata",
    status: "Out of reach",
    cls: "out",
    body: "Upload IP, the account a platform binds your file to, timestamps, sender→recipient. Created after this tool runs. No browser tool can touch it.",
  },
  {
    name: "Content",
    status: "Out of scope",
    cls: "out",
    body: "The street sign in the frame, the reflection in the window, sensor noise that identifies the physical camera. Still in the picture after any strip.",
  },
] as const;

export default function LayerPanel() {
  return (
    <div className="panel">
      <div className="panel-title">
        <h2>Three layers, and what we can actually reach</h2>
        <span className="meta">one of three</span>
      </div>
      <div className="layers">
        {LAYERS.map((l) => (
          <div className={`layer ${l.cls}`} key={l.name}>
            <span className="status">{l.status}</span>
            <h3>{l.name}</h3>
            <p>{l.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
