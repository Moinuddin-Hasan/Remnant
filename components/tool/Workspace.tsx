"use client";

import { useEffect, useState } from "react";
import Engine from "./Engine";
import ForgeEngine from "../forge/ForgeEngine";
import { useMode, type Mode } from "../ModeProvider";

/**
 * Inspect and Forge share one document.
 *
 * The route's CSP forbids the RSC fetch the App Router uses to navigate, so a
 * route change between them becomes a full page load and discards whatever
 * file is open. Keeping both here means a cleaned file reaches the forge by
 * reference — no upload, no browser storage, no navigation — and the nav bar
 * drives the switch through ModeProvider rather than a second tab strip.
 */
export default function Workspace({ initial = "inspect" }: { initial?: Mode }) {
  const { mode, setMode, register } = useMode();
  const [carried, setCarried] = useState<{ file: File; note: string } | null>(null);

  useEffect(() => {
    setMode(initial);
    register(true);
    return () => register(false);
    // Once, on mount: this declares which pane the route opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hand = (file: File, note: string, to: Mode) => {
    setCarried({ file, note });
    setMode(to);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return mode === "inspect" ? (
    <Engine
      initial={carried?.file ?? null}
      initialNote={carried?.note ?? null}
      onHandOff={(file, note) => hand(file, note, "forge")}
    />
  ) : (
    <ForgeEngine
      initial={carried?.file ?? null}
      initialNote={carried?.note ?? null}
      onHandOff={(file, note) => hand(file, note, "inspect")}
    />
  );
}
