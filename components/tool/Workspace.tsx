"use client";

import { useState } from "react";
import Engine from "./Engine";
import ForgeEngine from "../forge/ForgeEngine";
import Tabs from "../Tabs";

export type Mode = "inspect" | "forge";

/**
 * Inspect and Forge live in ONE document, as tabs, rather than on two routes.
 *
 * This is forced by the seal and it is the better design anyway. `connect-src
 * 'none'` blocks the RSC payload fetch that the App Router uses for
 * client-side navigation, so Next falls back to a full page load — which
 * discards any in-memory file and makes a route-to-route handoff impossible.
 *
 * Tabs sidestep that entirely: the file never leaves the component tree, so
 * cleaning something and then forging onto it costs no upload, no browser
 * storage, and no navigation. The seal stays absolute.
 */
export default function Workspace({ initial = "inspect" }: { initial?: Mode }) {
  const [mode, setMode] = useState<Mode>(initial);
  const [carried, setCarried] = useState<{ file: File; note: string } | null>(null);

  const hand = (file: File, note: string, to: Mode) => {
    setCarried({ file, note });
    setMode(to);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <>
      <Tabs active={mode} onSwitch={setMode} />

      {mode === "inspect" ? (
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
      )}
    </>
  );
}
