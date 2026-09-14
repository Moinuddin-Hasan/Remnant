"use client";

import type { EmbeddedAsset } from "@/lib/metadata/types";

const KIND_LABEL: Record<EmbeddedAsset["kind"], string> = {
  "second-image": "A second full-resolution image",
  "trailer-video": "A video hidden after the end of the image",
  "trailer-data": "Data after the end of the image",
  thumbnail: "An embedded thumbnail",
  "doc-thumbnail": "A rendered page-one thumbnail",
};

interface Preview {
  readonly asset: EmbeddedAsset;
  readonly url: string | null;
}

/**
 * The remnant layer — payload that is neither descriptive metadata nor the
 * content a viewer renders. This is the part no other stripper surfaces, so it
 * sits above the findings list rather than buried inside it.
 */
export default function RemnantReveal({ previews }: { previews: readonly Preview[] }) {
  if (previews.length === 0) return null;

  return (
    <div className="panel remnant">
      <div className="panel-title">
        <h2>Hidden inside this file</h2>
        <span className="meta">
          {previews.length} item{previews.length === 1 ? "" : "s"}
        </span>
      </div>
      {previews.map((p, i) => (
        <div className="asset" key={i}>
          {p.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.url} alt={KIND_LABEL[p.asset.kind]} />
          ) : null}
          <div className="asset-body">
            <div className="asset-kind">{KIND_LABEL[p.asset.kind]}</div>
            <div className="asset-note">{p.asset.note}</div>
            {p.url && (
              <div className="row-range" style={{ marginTop: 6 }}>
                bytes {p.asset.range.start.toLocaleString()}–
                {p.asset.range.end.toLocaleString()}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
