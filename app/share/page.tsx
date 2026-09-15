import dynamicImport from "next/dynamic";

export const dynamic = "force-dynamic";

const Dashboard = dynamicImport(() => import("@/components/share/Dashboard"), {
  loading: () => <p className="lede">Loading…</p>,
});

export default function SharePage() {
  return (
    <main className="container page">
      <p className="t-label">Remnant</p>
      <h1>Share</h1>
      <p className="lede">
        Encrypted in your browser, uploaded as ciphertext, opened with a key that only ever
        travels in the link.
      </p>
      <Dashboard />
    </main>
  );
}
