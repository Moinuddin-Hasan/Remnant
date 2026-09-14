import dynamicImport from "next/dynamic";

const Workspace = dynamicImport(() => import("@/components/tool/Workspace"), {
  loading: () => <p className="sub">Loading the engine…</p>,
});

export default function ForgePage() {
  return (
    <main className="wrap">
      <p className="eyebrow">Remnant</p>
      <h1>Forge</h1>
      <p className="sub">
        Write a new identity onto a file, then see what it reads back as and where it
        contradicts itself. Runs entirely in this tab.
      </p>
      <Workspace initial="forge" />
    </main>
  );
}
