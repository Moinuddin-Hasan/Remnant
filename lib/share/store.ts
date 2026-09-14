import path from "node:path";
import { FileShareStore } from "./store-file";
import { hostedConfigured, HostedShareStore, missingHostedConfig } from "./store-hosted";
import type { ShareStore } from "./types";

export * from "./types";
export { FileShareStore } from "./store-file";
export {
  HostedShareStore,
  hostedConfigured,
  blobConfigured,
  redisConfigured,
  missingHostedConfig,
} from "./store-hosted";

let singleton: ShareStore | null = null;

/**
 * Picks a backend from the environment rather than from a build flag.
 *
 * With Blob and Redis credentials present — a Vercel deployment — shares go to
 * hosted storage. Without them — `npm run dev`, a Docker self-host, the test
 * suite — they go to the filesystem. Nothing else in the codebase knows which
 * is in play.
 */
/**
 * A serverless function has a read-only filesystem, so the local backend is
 * not a fallback there — it is a crash waiting for the first upload. Rather
 * than let `mkdir '/var/task/.share-data'` surface as a mysterious ENOENT,
 * refuse up front and name the variable that is missing.
 */
export function shareStore(): ShareStore {
  if (!singleton) {
    if (hostedConfigured()) {
      singleton = new HostedShareStore();
    } else if (isServerless()) {
      throw new ShareNotConfiguredError(missingHostedConfig());
    } else {
      singleton = new FileShareStore(
        process.env.REMNANT_SHARE_DIR ?? path.join(process.cwd(), ".share-data"),
      );
    }
  }
  return singleton;
}

/** True on Vercel and on any other platform that runs us from a read-only bundle. */
export function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

export class ShareNotConfiguredError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      "Sharing is not configured on this deployment. This host has a read-only " +
        "filesystem, so hosted storage is required. Missing: " +
        missing.join(", ") +
        ". Set them in the project's environment variables and redeploy — variables " +
        "only reach deployments created after they are set.",
    );
    this.name = "ShareNotConfiguredError";
  }
}

export const storageMode = (): "hosted" | "local" => (hostedConfigured() ? "hosted" : "local");
