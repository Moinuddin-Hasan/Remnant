/**
 * The privacy claim is enforced here, not promised in the copy.
 *
 * `connect-src 'none'` on the tool route means the browser itself refuses any
 * outbound request the page tries to make — fetch, XHR, WebSocket, beacon. A
 * compromised transitive dependency cannot exfiltrate a file even if it tries.
 * That turns "nothing leaves your browser" from a claim a user has to trust
 * into one they can verify with the Network tab open.
 *
 * `worker-src 'self'` blocks blob-URL workers, which is the common Emscripten
 * bootstrap. Workers must therefore be same-origin files. Nothing here needs a
 * blob worker; if a dependency ever does, replace the dependency rather than
 * widening this policy.
 */
const isProduction = process.env.NODE_ENV === "production";

/**
 * Development needs two things production must never have.
 *
 * React's development build calls `eval()` to reconstruct callstacks, and HMR
 * needs a websocket. Sealing both in dev does not make the shipped product
 * safer — it just stops the page hydrating, so nothing works and the seal goes
 * untested where it matters. The production policy below is the real one, and
 * the end-to-end check asserts it against a production build for exactly that
 * reason.
 */
const BASE_CSP = [
  "default-src 'self'",
  isProduction
    ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

/**
 * Inspect, clean and forge. Nothing here has any business touching the network.
 *
 * In development the HMR socket is allowed, because without it the page does
 * not reload and the tool is unusable to work on. The shipped policy is the
 * sealed one.
 */
const SEALED_CSP = [
  ...BASE_CSP,
  isProduction ? "connect-src 'none'" : "connect-src 'self' ws: wss:",
].join("; ");

/**
 * Share routes, which need the network by definition.
 *
 * Kept separate rather than relaxing the tool's policy, because
 * `connect-src 'none'` on /tool is the claim the whole product rests on and it
 * is only worth making where it is actually true. Blob storage is named
 * explicitly so an upload cannot be redirected to an arbitrary host.
 */
const SHARE_CSP = [
  ...BASE_CSP,
  "connect-src 'self' https://*.public.blob.vercel-storage.com https://blob.vercel-storage.com" +
    (isProduction ? "" : " ws: wss:"),
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Required by docker/Dockerfile, which copies `.next/standalone` and refuses
   * to build without it. Harmless on Vercel, which ignores the setting, so the
   * hosted deployment and the self-host image build from one configuration.
   */
  output: "standalone",
  async headers() {
    return [
      {
        source: "/tool/:path*",
        headers: [
          { key: "Content-Security-Policy", value: SEALED_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/forge/:path*",
        headers: [
          { key: "Content-Security-Policy", value: SEALED_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/share/:path*",
        headers: [
          { key: "Content-Security-Policy", value: SHARE_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/s/:path*",
        headers: [
          { key: "Content-Security-Policy", value: SHARE_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Belt and braces: a fragment is never sent in a request anyway, but
          // no-referrer also stops the id leaking to anything the page loads.
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
