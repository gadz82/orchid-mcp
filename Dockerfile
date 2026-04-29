# orchid-mcp — production Dockerfile.
#
# Multi-stage: builder (compiles TS via tsup) → slim runtime.
# Non-root user, tini as PID 1 for clean signal handling, healthcheck
# against /health, production-only npm deps, pinned Node patch.

ARG NODE_IMAGE=node:20.18-alpine

# ─── Stage 1: builder ────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# ─── Stage 2: runtime ────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    ORCHID_MCP_PORT=9000

# tini — reaps zombies and propagates SIGTERM to node so docker stop
# doesn't hit the default 10s grace period.
RUN apk add --no-cache tini wget && \
    addgroup -S orchid 2>/dev/null || true && \
    adduser -S -G node orchid 2>/dev/null || true

# Install production deps only. `--ignore-scripts` avoids running any
# postinstall hooks from transitive deps during the image build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

COPY --from=builder /app/dist ./dist

# Pre-create the OAuth-state data dir with ``node:node`` ownership
# so a named volume mounted at ``/data`` inherits writable perms
# for the non-root runtime user.  Without this the file stores
# (clients.json / auth_codes.json / tokens.json) hit EACCES on
# their first write because Docker creates the volume root:root.
RUN mkdir -p /data && chown node:node /data

EXPOSE 9000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:${ORCHID_MCP_PORT}/health || exit 1

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
