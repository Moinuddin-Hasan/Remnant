"use client";

import Link from "next/link";

export type TabId = "inspect" | "forge" | "share";

/**
 * The three functions, as one strip.
 *
 * Inspect and Forge switch in place — they share a document precisely because
 * the sealed CSP blocks the RSC fetch the App Router needs to navigate, so
 * crossing between them by URL would be a full page load and would drop the
 * file being worked on. Share genuinely needs the network, so it has its own
 * document and its own policy, and is reached by a real link.
 */
export default function Tabs({
  active,
  onSwitch,
}: {
  readonly active: TabId;
  /** Provided on the sealed workspace, where Inspect/Forge are in-place. */
  readonly onSwitch?: (id: "inspect" | "forge") => void;
}) {
  const local = (id: "inspect" | "forge", label: string) =>
    onSwitch ? (
      <button className="tab" data-active={active === id} onClick={() => onSwitch(id)}>
        {label}
      </button>
    ) : (
      <Link
        className="tab"
        data-active={active === id}
        href={id === "inspect" ? "/tool" : "/forge"}
        prefetch={false}
      >
        {label}
      </Link>
    );

  return (
    <div className="tabs" role="tablist">
      {local("inspect", "Inspect & clean")}
      {local("forge", "Forge")}
      <Link className="tab" data-active={active === "share"} href="/share" prefetch={false}>
        Share
      </Link>
    </div>
  );
}
