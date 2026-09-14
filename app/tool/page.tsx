import dynamicImport from "next/dynamic";

/**
 * The sealed workspace. Inspect, clean and forge all live in this one document
 * because the route's CSP blocks the RSC fetch the App Router uses to navigate,
 * so anything on another route would be a full page load away — and a file
 * cannot survive that without being written somewhere it has no business being.
 */
const Workspace = dynamicImport(() => import("@/components/tool/Workspace"), {
  loading: () => <p className="lede">Loading the engine…</p>,
});

export default function ToolPage() {
  return (
    <main className="container page">
      <p className="t-label">Remnant</p>
      <h1>Inspect a file</h1>
      <p className="lede">Nothing is uploaded. Everything below happens in this tab.</p>
      <Workspace initial="inspect" />
    </main>
  );
}
