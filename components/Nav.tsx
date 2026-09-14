"use client";

import Link from "next/link";

/**
 * Brand only. The three functions live in the tab strip on each page rather
 * than up here, because two navigation systems on one screen is one too many.
 */
export default function Nav() {
  return (
    <nav className="nav">
      <Link href="/" className="nav-brand" prefetch={false}>
        Rem<span>nant</span>
      </Link>
      <span className="nav-note">nothing is uploaded</span>
    </nav>
  );
}
