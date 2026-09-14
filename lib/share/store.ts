import path from "node:path";
import { FileShareStore } from "./store-file";
import { hostedConfigured, HostedShareStore } from "./store-hosted";
import type { ShareStore } from "./types";

export * from "./types";
export { FileShareStore } from "./store-file";
export { HostedShareStore, hostedConfigured } from "./store-hosted";

let singleton: ShareStore | null = null;

/**
 * Picks a backend from the environment rather than from a build flag.
 *
 * With Blob and Redis credentials present — a Vercel deployment — shares go to
 * hosted storage. Without them — `npm run dev`, a Docker self-host, the test
 * suite — they go to the filesystem. Nothing else in the codebase knows which
 * is in play.
 */
export function shareStore(): ShareStore {
  if (!singleton) {
    singleton = hostedConfigured()
      ? new HostedShareStore()
      : new FileShareStore(
          process.env.REMNANT_SHARE_DIR ?? path.join(process.cwd(), ".share-data"),
        );
  }
  return singleton;
}

export const storageMode = (): "hosted" | "local" => (hostedConfigured() ? "hosted" : "local");
