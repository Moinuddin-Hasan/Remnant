import dynamic from "next/dynamic";

/**
 * The engine is the only importer of lib/metadata, loaded client-only.
 *
 * A static import anywhere in the shared tree would pull the parsers into a
 * chunk every visitor downloads, including people who never open the tool.
 */
const Engine = dynamic(() => import("@/components/tool/Engine"), {
  loading: () => <p className="sub">Loading the engine…</p>,
});

export default function ToolPage() {
  return (
    <main className="wrap">
      <p className="eyebrow">Remnant</p>
      <h1>Inspect a file</h1>
      <p className="sub">
        Nothing is uploaded. Everything below happens in this tab.
      </p>
      <Engine />
    </main>
  );
}
