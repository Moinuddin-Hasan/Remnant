import type { InspectResult } from "../pipeline";
import type { StripOptions, VerifyResult } from "../types";
import type { Request, Response } from "./worker";

type Pending = {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function spawn(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<Response>) => {
    const msg = event.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg as never);
    else p.reject(new Error(msg.error));
  });
  worker.addEventListener("error", (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || "worker failed"));
    pending.clear();
  });
  return worker;
}

/** `Omit` over a union collapses to the shared keys, dropping `opts`. Distribute instead. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function send<T>(payload: DistributiveOmit<Request, "id">): Promise<T> {
  const w = spawn();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: never) => void, reject });
    w.postMessage({ ...payload, id } as Request);
  });
}

/**
 * A busy worker cannot be interrupted from the outside, so cancellation is
 * terminate-and-respawn. Anything in flight is rejected rather than left
 * hanging.
 */
export function cancelAll(): void {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const [, p] of pending) p.reject(new Error("cancelled"));
  pending.clear();
}

export async function inspect(file: File): Promise<InspectResult> {
  const res = await send<{ data: InspectResult }>({ op: "inspect", file, name: file.name });
  return res.data;
}

export async function clean(
  file: File,
  opts?: StripOptions,
): Promise<{ verify: VerifyResult; rebuilt: boolean; rebuildReason?: string; output: Blob }> {
  const res = await send<{
    data: { verify: VerifyResult; rebuilt: boolean; rebuildReason?: string };
    output: Blob;
  }>({ op: "clean", file, name: file.name, opts });
  return { ...res.data, output: res.output };
}
