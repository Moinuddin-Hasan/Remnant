"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMode } from "./ModeProvider";

/**
 * The only navigation in the product.
 *
 * Inspect and Forge render as buttons while the workspace is mounted, because
 * switching between them must not navigate — they share a document so a file
 * can pass between them without an upload. Everywhere else they are ordinary
 * links.
 */
export default function Nav() {
  const path = usePathname();
  const { mode, setMode, inWorkspace } = useMode();

  const onWorkspace = path === "/tool" || path === "/forge";

  const isActive = (id: "home" | "inspect" | "forge" | "share") => {
    if (id === "home") return path === "/";
    if (id === "share") return path.startsWith("/share") || path.startsWith("/s/");
    if (!onWorkspace) return false;
    return mode === id;
  };

  const workspaceItem = (id: "inspect" | "forge", label: string) =>
    inWorkspace && onWorkspace ? (
      <button
        key={id}
        className="nav-link"
        data-active={isActive(id)}
        onClick={() => {
          setMode(id);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      >
        {label}
      </button>
    ) : (
      <Link
        key={id}
        className="nav-link"
        data-active={isActive(id)}
        href={id === "inspect" ? "/tool" : "/forge"}
        prefetch={false}
      >
        {label}
      </Link>
    );

  return (
    <header className="nav-bar">
      <div className="container nav">
        <Link href="/" className="nav-brand" prefetch={false}>
          Rem<span>nant</span>
        </Link>

        <nav className="nav-links" aria-label="Main">
          <Link className="nav-link" data-active={isActive("home")} href="/" prefetch={false}>
            Home
          </Link>
          {workspaceItem("inspect", "Inspect")}
          {workspaceItem("forge", "Forge")}
          <Link
            className="nav-link"
            data-active={isActive("share")}
            href="/share"
            prefetch={false}
          >
            Share
          </Link>
        </nav>
      </div>
    </header>
  );
}
