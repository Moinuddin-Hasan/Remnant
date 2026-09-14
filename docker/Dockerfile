# syntax=docker/dockerfile:1
#
# Self-hosted Remnant. Build from the repo root (compose.yml does this for you):
#   docker build -f docker/Dockerfile -t remnant:local .
#
# Three stages: install dependencies, build, then a runner that carries only
# Next's standalone server and static assets — no dev dependencies, no source,
# no fixtures — and runs as an unprivileged user.

ARG NODE_VERSION=22-alpine

# ---- deps -------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build ------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The runner copies public/ unconditionally; make sure it exists.
RUN mkdir -p public && npm run build
RUN test -f .next/standalone/server.js || { \
      echo >&2 'error: no .next/standalone output. next.config.mjs must set output: "standalone".'; \
      exit 1; }

# ---- runner -----------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S -g 1001 remnant \
 && adduser -S -u 1001 -G remnant remnant \
 && mkdir -p /data \
 && chown remnant:remnant /data

COPY --from=build --chown=remnant:remnant /app/.next/standalone ./
COPY --from=build --chown=remnant:remnant /app/.next/static ./.next/static
COPY --from=build --chown=remnant:remnant /app/public ./public

USER remnant
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1

CMD ["node", "server.js"]
