# orchid-mcp — AI Context

## What This Package Is

**orchid-mcp** is a TypeScript/Node.js **MCP gateway** that exposes the Orchid multi-agent framework as a remote Model Context Protocol server over Streamable HTTP. Any MCP-capable AI client (Claude Desktop, Claude Code, Cursor, …) can install the gateway URL and the host LLM can call `orchid_ask(...)` — the gateway proxies HTTP calls to the existing `orchid-api` FastAPI service, which runs the real supervisor + agents + RAG + MCP tools.

This package is a **thin gateway**. It owns only four things: MCP transport, identity resolution, session mapping, and HTTP translation. It never duplicates framework logic.

## Package Structure

```
orchid-mcp/
  src/
    index.ts                    Entry point — load settings, build strategy/client/server, listen
    server.ts                   HTTP + MCP Streamable HTTP transport; mounts auth-strategy routes
    settings.ts                 Zod-validated env config (ORCHID_MCP_*)
    context.ts                  AppContext bag (deps injected into tool handlers)
    errors.ts                   Narrow gateway error types
    rateLimit.ts                RateLimiter interface + TokenBucket + Noop impls
    auth/
      base.ts                   AuthStrategy + AuthRoute + MCPRequestContext + OrchidIdentity
      serviceAccount.ts         Static bearer strategy + 0.0.0.0 deployment guard
      oauth.ts                  MCPOAuthStrategy (MCP 2025-03-26 AS role) + IdPTokens type
      stores.ts                 ClientStore / AuthCodeStore / GatewayTokenStore + memory impls
      gatewayStateClient.ts     HTTP client for orchid-api /mcp-gateway/state/* (Phase 3)
      httpStores.ts             Phase-3 ClientStore/AuthCodeStore/TokenStore over HTTP
      upstreamDiscovery.ts      ``discover`` mode — pulls /auth-info from orchid-api
      upstreamPosture.ts        Startup probe — fails fast on auth-mode mismatch
    sessions/
      base.ts                   SessionMap interface
      memory.ts                 LRU-cache-backed in-process implementation
    http/
      orchidClient.ts           OrchidAPIClient interface + zod schemas (response shapes)
      undiciOrchidClient.ts     Concrete impl backed by Node fetch
      circuitBreaker.ts         Per-method opossum wrapper around OrchidAPIClient
      sseParser.ts              Phase-9 streaming SSE frame parser
    tools/
      registry.ts               Registers the six tools
      _shared.ts                buildRequestContext / buildCallOptions / errorToResult /
                                runWithTooling (correlation + span + rate-limit wrapper)
      askOrchid.ts              orchid_ask
      chatMgmt.ts               orchid_new_chat / orchid_list_chats / orchid_switch_chat
      upload.ts                 orchid_upload_file
      resume.ts                 orchid_resume_chat
    mcpGateway/
      applyConfig.ts            Per-session GET /mcp-gateway/config → tool/prompt overrides
    observability/
      logger.ts                 Pino factory
      correlation.ts            AsyncLocalStorage-backed request context
      tracing.ts                OTEL NodeSDK bootstrap + withToolSpan helper
  test/
    _helpers/
      fakeIdP.ts                In-process OIDC IdP for OAuth tests
    askOrchid.test.ts           orchid_ask unit tests
    authOauth.test.ts           MCPOAuthStrategy + full OAuth flow + Phase-4 delegate tests
    authServiceAccount.test.ts  Service-account strategy + deployment guard
    chatMgmt.test.ts            new/list/switch chat tools
    circuitBreaker.test.ts      Circuit breaker wrapper
    correlation.test.ts         Request-scoped correlation context
    gatewayStateClient.test.ts  Phase-3 HTTP-store + GatewayStateClient (msw)
    importBoundaries.test.ts    Static HTTP-only boundary guard
    integration.test.ts         Opt-in testcontainers integration (RUN_INTEGRATION=1)
    mcpGatewayApply.test.ts     Per-session config application
    mcpGatewayTemplate.test.ts  Prompt-template rendering
    orchidClient.test.ts        HTTP client + error mapping (msw)
    rateLimit.test.ts           Token-bucket behaviour
    resume.test.ts              orchid_resume_chat
    server.test.ts              End-to-end via StreamableHTTPClientTransport
    sessionMap.test.ts          MemorySessionMap + TTL
    smoke.test.ts               Settings parsing + MCP spec pin + retired-env-var guards
    sseParser.test.ts           SSE frame parsing
    streaming.test.ts           Phase-9 progress-token streaming
    tracing.test.ts             OTEL span shape via InMemorySpanExporter
    upload.test.ts              orchid_upload_file
    upstreamDiscovery.test.ts   ``discover`` mode merge logic
    upstreamPosture.test.ts     Startup posture-probe behaviour
```

## Architecture Rules (Hard)

1. **HTTP-only boundary.** `src/` never imports anything from `orchid/`, `orchid-api/`, or any Python source. There is no shared code with the Python packages. The `test/importBoundaries.test.ts` guard fails the build on the first violation.

2. **SOLID at every seam.** `AuthStrategy`, `SessionMap`, `OrchidAPIClient`, `GatewayStateClient`, `ClientStore`, `AuthCodeStore`, `GatewayTokenStore`, `RateLimiter` are all narrow interfaces with swappable implementations. Tool handlers depend on these interfaces, never on concrete classes. Adding a new auth mode, session backend, token-store backend, or HTTP client implementation must not require editing consumers.

3. **Zod at every external boundary.** Settings, tool inputs, and `orchid-api` response bodies are all parsed with Zod. A shape mismatch fails loudly with a clear error rather than silently propagating garbage.

4. **Pin the MCP SDK.** `package.json` pins `@modelcontextprotocol/sdk` to an exact version; `src/server.ts` exports `MCP_SPEC_REVISION`. An SDK upgrade is deliberate and requires bumping both.

5. **Tests land with code.** Every phase completes with `npm run typecheck && npm run lint && npm test` all green. Coverage targets: ≥90% for `src/http/` and `src/sessions/`; ≥80% overall.

6. **Every tool goes through `runWithTooling`.** Tool registration callbacks delegate to `runWithTooling(ctx, toolName, extra, body)` in `_shared.ts`. That helper applies correlation id + pino child logger + rate-limit check + OTEL tool span in a uniform order. Bypassing it is a bug.

## Dependency Direction

```
orchid-mcp/ ──HTTP──▶ orchid-api/ ──Python──▶ orchid/
```

Everything the gateway knows about an Orchid chat comes from an HTTP call. The gateway never reads `orchid-api`'s Postgres/Qdrant directly.

## Key Runtime Dependencies

| Package                                       | Role                                                            |
| --------------------------------------------- | --------------------------------------------------------------- |
| `@modelcontextprotocol/sdk`                   | Official MCP TypeScript SDK (pinned)                            |
| `zod`                                         | Tool-input, settings, and upstream-response validation          |
| `undici`                                      | HTTP client (Agent-backed pool, finer-grained timeouts)         |
| `pino`                                        | Structured JSON logging                                         |
| `lru-cache`                                   | In-memory session + store backing                               |
| `openid-client`                               | Upstream OIDC helpers (scoped use — most OAuth is raw fetch)    |
| `opossum`                                     | Circuit breaker                                                 |
| `@opentelemetry/api` + `sdk-node`             | Tracing (opt-in via `ORCHID_MCP_TRACING_ENABLED`)               |
| `@opentelemetry/instrumentation-undici`       | Automatic undici span emission when tracing is on               |
| `ioredis` _(optional)_                        | Redis-backed session map for multi-replica deployments          |

## Configuration

All config lives in environment variables prefixed with `ORCHID_MCP_`. `settings.ts` is the single source of truth; anything else is a bug. The full matrix is in `README.md`. High-level sections:

- **Core** — upstream URL, timeout, host/port, log level, session backend + TTL.
- **Auth** — `AUTH_MODE` switches between `service_account` (shared bearer), `oauth` (per-user OAuth AS role with explicit endpoint env vars), and `discover` (per-user OAuth AS role with endpoints fetched from `orchid-api`'s `/auth-info`). The gateway holds **no upstream secrets**: code exchange, identity resolution, and refresh-token rotation all delegate to `orchid-api` (Phases 1–5 of the auth-centralisation roadmap — see [.knowledge/auth-centralisation.md](../.knowledge/auth-centralisation.md)).
- **Gateway state** — `OAUTH_STORE_BACKEND=memory|http`. The `http` backend persists DCR clients + auth codes + tokens via `orchid-api`'s `/mcp-gateway/state/*` endpoints so multiple gateway replicas share state. Requires `GATEWAY_STATE_SERVICE_TOKEN` to match `orchid-api`'s `MCP_GATEWAY_STATE_SERVICE_TOKEN`.
- **Hardening** — rate limiter (rpm + burst), circuit breaker (error threshold + reset + window).
- **Observability** — tracing gate + OTLP endpoint + service name.

## Running

```bash
# Development:
cd orchid-mcp
npm install
npm run dev              # tsx watch — picks up source changes

# Checks:
npm run typecheck
npm run lint
npm test
npm run test:coverage

# Production-like:
npm run build
node dist/index.js

# Docker:
docker build -t orchid-mcp:dev .
docker run --rm -p 9000:9000 -e ORCHID_MCP_SERVICE_ACCOUNT_TOKEN=x \
    -e ORCHID_MCP_HOST=0.0.0.0 -e ORCHID_MCP_I_UNDERSTAND_THE_RISK=true \
    orchid-mcp:dev
```

The gateway exposes:

- `GET /health` — readiness probe (also used by the Dockerfile's `HEALTHCHECK`).
- `POST /mcp` (and `GET`, `DELETE`) — MCP Streamable HTTP in stateful mode.
- When `authMode=oauth` or `discover`: `/authorize`, `/oauth/callback`, `/token`, `/register`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`.

## MCP gateway exposure config (fetched per session)

At each MCP session init the gateway calls orchid-api's
``GET /mcp-gateway/config`` — once — using the session's resolved
bearer (service-account or OAuth-issued).  The response (see
``src/mcpGateway/applyConfig.ts``) applies:

- **Tool title/description overrides** via ``RegisteredTool.update()``
  before the client's ``tools/list`` returns.
- **MCP Prompts** via ``server.registerPrompt()`` — each prompt
  renders its ``{{var}}`` template client-side on ``prompts/get``.

The fetch is **best-effort** — missing / unreachable / 4xx endpoint
falls back to the gateway's built-in defaults with a single warning
log.  A session always comes up.  See ``src/server.ts`` →
``tryFetchGatewayConfig``.  The config is entirely optional upstream
(orchid/ ships defaults).

## Common Pitfalls

- **Do not import from the sibling Python packages.** The import-boundary test will fail the build. If you find yourself tempted, make the gateway ask orchid-api over HTTP instead.
- **Do not bypass Zod.** Every response from orchid-api is parsed — don't pass `unknown` through to tool handlers.
- **Tool-input schemas must match the upstream Pydantic models.** See `src/http/orchidClient.ts` for the canonical list. Fields like `InterruptResponse.approvals_needed[].interrupt_id` are load-bearing — rename them on one side and Zod parse failures stop the gateway.
- **Service-account mode + `host: 0.0.0.0`** is deliberately guarded by `ORCHID_MCP_I_UNDERSTAND_THE_RISK=true`. In that mode every MCP user shares one Orchid identity — fine for a personal install, unacceptable for public deploys.
- **`/register` (DCR) is unauthenticated by default.** Any MCP client can register. For operator-provisioned clients, set `ORCHID_MCP_OAUTH_CLIENT_REGISTRATION_ENABLED=false`.
- **Session map TTL matters.** The default is 7 days; anything shorter and a user's "which chat was I in" state evaporates mid-conversation.
- **The rate limiter keys on `mcpSessionId`, not OAuth subject.** One user across multiple Claude Desktop installs gets a separate bucket per session — by design, to avoid punishing everyone when one client goes wild. Layered OAuth-subject rate limiting can live on top.
- **Do not edit `orchid/` or `orchid-api/` as a side effect of gateway work.** If an upstream change is genuinely required, STOP and flag it — those are separate packages under the monorepo rules.
- **The gateway holds no upstream OAuth secrets.** After Phases 2–5, `client_secret` / `token_endpoint` / `userinfo_endpoint` / JSON-path hints all live on `orchid-api`. If you find yourself adding any of them back to `UpstreamIdPConfig` or `Settings`, you're undoing Phase 5 — there's an `authOauth.test.ts > phase-5 hygiene` regression guard for this.
- **Tool handlers MUST go through `runWithTooling`.** Skipping it breaks correlation ids, spans, and the rate-limiter — a silent failure mode.
