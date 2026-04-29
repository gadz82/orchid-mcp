# orchid-mcp

A Model Context Protocol (MCP) gateway that exposes the [Orchid](../orchid/) multi-agent framework to any MCP-capable AI client — **Claude Desktop, Claude Code, Cursor, MCP Inspector, or anything that speaks the MCP 2025-03-26 Streamable HTTP transport**.

The gateway is a **thin proxy**. The host LLM calls `orchid_ask(...)` and the gateway translates that into HTTP calls against the existing `orchid-api` FastAPI service. Orchid's supervisor, agents, RAG, and downstream MCP tools run upstream; session continuity, auth, multi-tenancy, and HITL are preserved.

```
MCP client ──Streamable HTTP──▶ orchid-mcp ──HTTP──▶ orchid-api ──▶ orchid (library)
```

## Tools

The gateway registers six MCP tools on every session:

| Tool                  | Purpose                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `orchid_ask`          | Ask Orchid's supervisor a question. Auto-creates a chat on first call, files attach here. |
| `orchid_new_chat`     | Start a fresh chat and bind the current MCP session to it.                                |
| `orchid_list_chats`   | List the user's existing chats.                                                           |
| `orchid_switch_chat`  | Bind the current MCP session to a prior chat id.                                          |
| `orchid_upload_file`  | Upload a base64-encoded file into the current chat's RAG scope.                           |
| `orchid_resume_chat`  | Resume a HITL-paused chat with an approved/denied decision.                               |

## Quickstart — Docker Compose

The shortest path from zero to a working MCP endpoint:

```bash
# from the monorepo root
docker compose -f docker-compose.demo.yml up --build

# smoke-check
curl http://localhost:9000/health
# → {"status":"ok","service":"orchid-mcp","version":"0.1.0-dev","mcpSpec":"2025-03-26"}
```

Then [point an MCP client at it](#install-in-an-mcp-client).

## Install in an MCP client

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
    "mcpServers": {
        "orchid": {
            "type": "http",
            "url": "http://localhost:9000/mcp"
        }
    }
}
```

Restart Claude Desktop. The six `orchid_*` tools should appear under the attach-tool menu.

### Claude Code

`.mcp.json` at your project root (or `~/.claude.json` for a user-wide install):

```json
{
    "mcpServers": {
        "orchid": {
            "type": "http",
            "url": "http://localhost:9000/mcp"
        }
    }
}
```

Restart `claude` and run `/mcp` to confirm the server is connected.

### Cursor

`~/.cursor/mcp.json`:

```json
{
    "mcpServers": {
        "orchid": {
            "url": "http://localhost:9000/mcp"
        }
    }
}
```

### MCP Inspector (development)

```bash
npx @modelcontextprotocol/inspector@latest
# Transport type: Streamable HTTP
# URL:            http://localhost:9000/mcp
```

## Configuration

All config is environment variables prefixed with `ORCHID_MCP_`. `src/settings.ts` is the single source of truth.

### Core

| Variable                                 | Default                 | Purpose                                                   |
| ---------------------------------------- | ----------------------- | --------------------------------------------------------- |
| `ORCHID_MCP_ORCHID_API_URL`              | `http://localhost:8000` | Upstream orchid-api base URL                              |
| `ORCHID_MCP_ORCHID_API_TIMEOUT_MS`       | `120000`                | Per-request timeout (supports multi-agent runs)           |
| `ORCHID_MCP_HOST`                        | `0.0.0.0`               | Listen host                                               |
| `ORCHID_MCP_PORT`                        | `9000`                  | Listen port                                               |
| `ORCHID_MCP_LOG_LEVEL`                   | `info`                  | Pino log level (`trace`/`debug`/`info`/`warn`/`error`)    |
| `ORCHID_MCP_SESSION_MAP_BACKEND`         | `memory`                | `memory` \| `redis`                                       |
| `ORCHID_MCP_SESSION_MAP_REDIS_URL`       | —                       | Required when backend is `redis`                          |
| `ORCHID_MCP_SESSION_TTL_S`               | `604800`                | Session map TTL, seconds (default 7 days)                 |

### Auth

The gateway holds **no upstream OAuth secrets** and no userinfo / JSON-path
config. The secret-bearing code exchange, identity resolution, and refresh
grant all happen on `orchid-api` via `/auth/exchange-code`,
`/auth/resolve-identity`, and `/auth/refresh-token`. See
[`.knowledge/auth-centralisation.md`](../.knowledge/auth-centralisation.md)
for the full architecture.

| Variable                                   | Default             | Purpose                                                                  |
| ------------------------------------------ | ------------------- | ------------------------------------------------------------------------ |
| `ORCHID_MCP_AUTH_MODE`                     | `service_account`   | `service_account` \| `oauth` \| `discover`                               |
| `ORCHID_MCP_SERVICE_ACCOUNT_TOKEN`         | —                   | Bearer token (required in `service_account` mode)                        |
| `ORCHID_MCP_SERVICE_ACCOUNT_AUTH_DOMAIN`   | —                   | Optional `x-auth-domain` override                                        |
| `ORCHID_MCP_I_UNDERSTAND_THE_RISK`         | `false`             | Required to bind `service_account` + `0.0.0.0` (see "Auth modes")        |
| `ORCHID_MCP_OAUTH_ISSUER_URL`              | filled by discovery | Upstream IdP issuer (for `oauth` mode)                                   |
| `ORCHID_MCP_OAUTH_AUTHORIZATION_ENDPOINT`  | filled by discovery | Upstream IdP `/authorize` URL                                            |
| `ORCHID_MCP_OAUTH_CLIENT_ID`               | filled by discovery | Gateway's public PKCE client_id at the upstream IdP                      |
| `ORCHID_MCP_OAUTH_AUTH_DOMAIN`             | filled by discovery | Optional X-Auth-Domain hint forwarded to orchid-api                      |
| `ORCHID_MCP_OAUTH_SCOPES`                  | filled by discovery | Scope string requested from upstream                                     |
| `ORCHID_MCP_OAUTH_GATEWAY_BASE_URL`        | —                   | Public URL the gateway is reachable at (goes into metadata)              |
| `ORCHID_MCP_OAUTH_TOKEN_TTL_S`             | `3600`              | Lifetime of gateway-issued access tokens                                 |
| `ORCHID_MCP_OAUTH_CLIENT_REGISTRATION_ENABLED` | `true`          | Whether `/register` (RFC 7591 DCR) is exposed                            |
| `ORCHID_MCP_OAUTH_STORE_BACKEND`           | `memory`            | `memory` \| `http` — Phase 3 multi-replica state sharing                 |
| `ORCHID_MCP_GATEWAY_STATE_SERVICE_TOKEN`   | —                   | Required when `OAUTH_STORE_BACKEND=http`; matches orchid-api's setting   |

**Retired in Phase 5** — the following env vars now fail strict-mode parsing (operators with stale `.env` files get a loud error rather than a silent no-op): `ORCHID_MCP_OAUTH_TOKEN_ENDPOINT`, `ORCHID_MCP_OAUTH_USERINFO_ENDPOINT`, `ORCHID_MCP_OAUTH_CLIENT_SECRET`, `ORCHID_MCP_OAUTH_USERINFO_SUB_PATH`, `ORCHID_MCP_OAUTH_USERINFO_EMAIL_PATH`, `ORCHID_MCP_OAUTH_EXCHANGE_VIA_API`, `ORCHID_MCP_OAUTH_RESOLVE_VIA_API`, `ORCHID_MCP_OAUTH_REFRESH_VIA_API`, `ORCHID_MCP_OAUTH_IDENTITY_RESOLVER_MODULE`. All of these concerns moved to `orchid-api`.

### Hardening

| Variable                                         | Default | Purpose                                                     |
| ------------------------------------------------ | ------- | ----------------------------------------------------------- |
| `ORCHID_MCP_RATE_LIMIT_ENABLED`                  | `true`  | Toggle the per-MCP-session token-bucket limiter             |
| `ORCHID_MCP_RATE_LIMIT_RPM`                      | `60`    | Sustained tool-calls-per-minute per session                 |
| `ORCHID_MCP_RATE_LIMIT_BURST`                    | `30`    | Burst allowance                                             |
| `ORCHID_MCP_CIRCUIT_BREAKER_ENABLED`             | `true`  | Wrap the orchid-api client in per-method breakers           |
| `ORCHID_MCP_CIRCUIT_BREAKER_ERROR_THRESHOLD_PCT` | `50`    | Error rate (%) in the rolling window that trips the breaker |
| `ORCHID_MCP_CIRCUIT_BREAKER_RESET_MS`            | `30000` | How long the breaker stays open before probing half-open    |
| `ORCHID_MCP_CIRCUIT_BREAKER_ROLLING_WINDOW_MS`   | `10000` | Rolling statistics window                                   |

### Observability

| Variable                              | Default        | Purpose                                                 |
| ------------------------------------- | -------------- | ------------------------------------------------------- |
| `ORCHID_MCP_TRACING_ENABLED`          | `false`        | Gate for OTEL — must be `true` AND the endpoint set     |
| `ORCHID_MCP_OTEL_SERVICE_NAME`        | `orchid-mcp`   | OTEL `service.name` resource attribute                  |
| `ORCHID_MCP_OTEL_EXPORTER_OTLP_ENDPOINT` | —           | OTLP HTTP endpoint (e.g. `http://otel-collector:4318`)  |

## Auth modes

### `service_account` (default)

One static bearer token, shared across every MCP user. Perfect for a single-user personal install — risky on a public endpoint because **every MCP client shares one Orchid identity**. The gateway refuses to bind to `0.0.0.0` in `service_account` mode unless you also set `ORCHID_MCP_I_UNDERSTAND_THE_RISK=true`.

### `oauth` / `discover`

MCP 2025-03-26 OAuth 2.0 authorization-server role. The gateway:

1. Advertises metadata at `/.well-known/oauth-authorization-server` + `/.well-known/oauth-protected-resource`.
2. Accepts Dynamic Client Registration at `/register` (PKCE-only, no client secrets).
3. Sends users to the upstream IdP's `/authorize` endpoint to log in.
4. On callback, **delegates to `orchid-api`** for the secret-bearing code exchange, identity resolution, and any future refresh-token rotation. The gateway never holds `client_secret` or hits `/userinfo` directly.
5. Mints opaque gateway-issued access tokens keyed to the resolved `OrchidIdentity` (`{bearer, subject, authDomain?}`).
6. The `MCPOAuthStrategy` verifies incoming MCP bearer tokens against its token store on every tool invocation.

Use `ORCHID_MCP_AUTH_MODE=discover` (recommended) to fetch the upstream
issuer + authorize URL + public `client_id` from `orchid-api`'s
`GET /auth-info` at startup. Use `ORCHID_MCP_AUTH_MODE=oauth` to set
those values explicitly via env vars (rare — useful only when
`orchid-api` doesn't have an `OrchidAuthConfigProvider` wired).

Consumer-specific identity logic (e.g. mapping a tenant's non-OIDC
userinfo shape to a normalised identity, or minting a custom bearer
for downstream APIs) lives **on the orchid-api side** in an
`OrchidIdentityResolver` subclass.

## Development

```bash
cd orchid-mcp
npm install
npm run dev              # tsx watch — picks up source changes on save

# checks
npm run typecheck
npm run lint
npm test                 # unit + mocked integration (fast)
npm run test:coverage

# opt-in: exercise against a real orchid-api container
RUN_INTEGRATION=1 npm test -- test/integration.test.ts

# production-like
npm run build
node dist/index.js
```

## Docker build

```bash
# from the monorepo root
docker build -t orchid-mcp:dev orchid-mcp/

docker run --rm -p 9000:9000 \
    -e ORCHID_MCP_SERVICE_ACCOUNT_TOKEN=demo \
    -e ORCHID_MCP_HOST=0.0.0.0 \
    -e ORCHID_MCP_I_UNDERSTAND_THE_RISK=true \
    -e ORCHID_MCP_ORCHID_API_URL=http://host.docker.internal:8080 \
    orchid-mcp:dev

curl http://localhost:9000/health
```

## Troubleshooting

- **`501 Not Implemented` on `POST /mcp`** — you're hitting a pre-Phase-3 build. Rebuild the image or pull a current `dist/index.js`.
- **`Refusing to bind service_account mode to 0.0.0.0` on startup** — expected safety rail. Set `ORCHID_MCP_I_UNDERSTAND_THE_RISK=true` (single-user) or switch to `oauth` mode (multi-user) or bind to `127.0.0.1`.
- **`Upstream circuit breaker open for <method>`** — the upstream orchid-api has been failing the gateway's calls. Check `/health` on orchid-api, then either wait 30s for the breaker to probe half-open or restart the gateway.
- **`Rate limit exceeded. Retry in ~Xs`** — the current MCP session burned through its `ORCHID_MCP_RATE_LIMIT_RPM` budget. Either wait, or raise the limit.
- **No tools visible in Claude Desktop** — confirm the URL in `claude_desktop_config.json` ends with `/mcp`, and restart the app (not just the window).

## See also

- [AGENTS.md](./AGENTS.md) — architecture rules, SOLID seams, package structure
- [.knowledge/auth-centralisation.md](../.knowledge/auth-centralisation.md) — Phases 1–5 of the auth-centralisation roadmap (the design + migration matrix for the current `discover`-mode architecture)
- [.knowledge/orchid-mcp-gateway-plan.md](../.knowledge/orchid-mcp-gateway-plan.md) — original gateway design document
- [orchid-api/](../orchid-api/) — the FastAPI service this gateway proxies to
