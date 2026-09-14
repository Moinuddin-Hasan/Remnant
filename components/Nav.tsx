"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/tool", label: "Inspect" },
  { href: "/forge", label: "Forge" },
  { href: "/share", label: "Share" },
] as const;

export default function Nav() {
  const path = usePathname();

  return (
    <nav className="nav">
      <Link href="/" className="nav-brand" prefetch={false}>
        Remnant
      </Link>
      <div className="nav-links">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="nav-link"
            // The sealed routes block the RSC fetch that prefetch relies on, so
            // asking for it just fills the console with CSP violations and
            // achieves nothing. Navigation still works — Next falls back to a
            // full page load, which on these routes is what we want anyway.
            prefetch={false}
            data-active={path === l.href || path.startsWith(`${l.href}/`)}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
