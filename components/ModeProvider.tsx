"use client";

import { createContext, useContext, useMemo, useState } from "react";

export type Mode = "inspect" | "forge";

interface ModeState {
  readonly mode: Mode;
  readonly setMode: (m: Mode) => void;
  /** True only while the sealed workspace is mounted. */
  readonly inWorkspace: boolean;
  readonly register: (on: boolean) => void;
}

const Ctx = createContext<ModeState | null>(null);

/**
 * Lets the nav bar switch Inspect and Forge without navigating.
 *
 * Those two share a single document on purpose: the sealed route forbids the
 * RSC fetch the App Router uses for client-side navigation, so a route change
 * between them degrades to a full page load and the file being worked on is
 * gone. The provider sits above the nav so one bar can drive both — a link
 * when there is no workspace, an in-place switch when there is.
 */
export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>("inspect");
  const [count, setCount] = useState(0);

  const value = useMemo<ModeState>(
    () => ({
      mode,
      setMode,
      inWorkspace: count > 0,
      register: (on: boolean) => setCount((n) => Math.max(0, n + (on ? 1 : -1))),
    }),
    [mode, count],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMode(): ModeState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMode must be used inside ModeProvider");
  return ctx;
}
