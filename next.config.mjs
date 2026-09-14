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
const TOOL_CSP = [
  "default-src 'self'",
  "connect-src 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/tool/:path*",
        headers: [
          { key: "Content-Security-Policy", value: TOOL_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
