/// <reference lib="webworker" />
import { cleanFile, inspectFile } from "../pipeline";
import { DEFAULT_STRIP, type StripOptions } from "../types";

/**
 * Parsing runs here so a 200 MB file cannot freeze the tab.
 *
 * `File` and `Blob` are structured-cloneable by reference, so posting one
 * across costs nothing — the worker receives a disk-backed handle, not a copy.
 * The worker is a same-origin module file because the route's CSP sets
 * `worker-src 'self'`, which blocks the blob-URL bootstrap most bundlers emit.
 */

export type Request =
  | { readonly id: number; readonly op: "inspect"; readonly file: Blob; readonly name: string }
  | {
      readonly id: number;
      readonly op: "clean";
      readonly file: Blob;
      readonly name: string;
      readonly opts?: StripOptions;
    };

export type Response =
  | { readonly id: number; readonly ok: true; readonly op: "inspect"; readonly data: unknown }
  | {
      readonly id: number;
      readonly ok: true;
      readonly op: "clean";
      readonly data: unknown;
      readonly output: Blob;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener("message", async (event: MessageEvent<Request>) => {
  const msg = event.data;
  try {
    if (msg.op === "inspect") {
      const result = await inspectFile(msg.file, msg.name);
      ctx.postMessage({ id: msg.id, ok: true, op: "inspect", data: result } satisfies Response);
      return;
    }
    const { output, verify, rebuilt, rebuildReason } = await cleanFile(
      msg.file,
      msg.name,
      msg.opts ?? DEFAULT_STRIP,
    );
    ctx.postMessage({
      id: msg.id,
      ok: true,
      op: "clean",
      data: { verify, rebuilt, rebuildReason },
      output,
    } satisfies Response);
  } catch (err) {
    ctx.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies Response);
  }
});
