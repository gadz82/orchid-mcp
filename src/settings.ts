import { z } from "zod";

export const SettingsSchema = z
    .object({
        orchidApiUrl: z.string().url().default("http://localhost:8000"),
        orchidApiTimeoutMs: z.coerce.number().int().positive().default(600_000),

        /**
         * ``service_account`` — shared bearer token for every request.
         * ``oauth`` — MCP 2025-03-26 AS role, operator supplies all
         *   OAuth settings (``ORCHID_MCP_OAUTH_*``) via env.
         * ``discover`` — same OAuth flow, but upstream endpoint URLs +
         *   public ``client_id`` come from orchid-api's
         *   ``GET /auth-info`` so the operator configures OAuth once
         *   in ``orchid.yml`` instead of duplicating env vars here.
         *   The gateway still holds its own ``client_secret`` in
         *   ``ORCHID_MCP_OAUTH_CLIENT_SECRET`` (Phase 1 boundary —
         *   Phase 2 moves the secret to orchid-api).
         */
        authMode: z
            .enum(["service_account", "oauth", "discover"])
            .default("service_account"),
        serviceAccountToken: z.string().optional(),
        serviceAccountAuthDomain: z.string().optional(),

        // Upstream OIDC IdP — minimum needed to build the
        // ``/authorize`` redirect URL.  Phase 5 retired the
        // gateway-side ``token_endpoint`` / ``userinfo_endpoint`` /
        // ``client_secret`` / JSON-path-hint config: the gateway
        // delegates exchange + identity + refresh to orchid-api on
        // every flow, so the only upstream knowledge it needs is
        // where to send users for the browser-based authorization
        // dance.
        oauthIssuerUrl: z.string().url().optional(),
        oauthAuthorizationEndpoint: z.string().url().optional(),
        oauthClientId: z.string().optional(),
        oauthScopes: z.string().default("openid profile email"),
        /**
         * Platform domain to attach as ``X-Auth-Domain`` on every
         * request to orchid-api.  For single-tenant deployments
         * this is the tenant host (e.g. ``mytenant.example.com``)
         * and overrides any heuristic derivation orchid-api's
         * resolver might have made.  Discovered via ``discover`` mode
         * from orchid-api's :class:`OrchidAuthConfigProvider`; may
         * also be set directly via ``ORCHID_MCP_OAUTH_AUTH_DOMAIN``.
         */
        oauthAuthDomain: z.string().optional(),

        // Gateway-as-AS
        /** Public URL the gateway is reachable at (for metadata documents). */
        oauthGatewayBaseUrl: z.string().url().optional(),
        /** TTL for gateway-issued access tokens, in seconds. */
        oauthTokenTtlS: z.coerce.number().int().positive().default(3600),
        /** Whether the gateway's /register endpoint is enabled (RFC 7591 DCR). */
        oauthClientRegistrationEnabled: z.coerce.boolean().default(true),
        /**
         * Backend for the three gateway OAuth state stores (DCR
         * registrations, in-flight auth codes, issued access /
         * refresh tokens):
         *
         * - ``memory`` (default) — in-process LRU caches.  Fine for
         *   unit tests and single-replica personal deploys; state
         *   evaporates on restart.
         * - ``http`` — delegates to orchid-api's
         *   ``/mcp-gateway/state/*`` endpoints (Phase 3).  Lets
         *   multiple gateway replicas share the same registrations,
         *   codes, and tokens via the orchid-api DB.  Requires
         *   ``gatewayStateServiceToken`` to match the orchid-api
         *   ``MCP_GATEWAY_STATE_SERVICE_TOKEN`` setting.
         *
         * The ``file`` backend from the initial Phase 3 draft was
         * retired in Phase 4 — cross-restart persistence is now the
         * ``http`` backend's job (same durability, no local disk).
         * ``undefined`` resolves to ``memory``.
         */
        oauthStoreBackend: z.enum(["memory", "http"]).optional(),
        /**
         * Shared secret used to authenticate ``/mcp-gateway/state/*``
         * requests against orchid-api.  Required when
         * ``oauthStoreBackend`` resolves to ``http``; unused
         * otherwise.  The value must match orchid-api's
         * ``MCP_GATEWAY_STATE_SERVICE_TOKEN`` setting byte-for-byte.
         * Env var: ``ORCHID_MCP_GATEWAY_STATE_SERVICE_TOKEN``.
         */
        gatewayStateServiceToken: z.string().optional(),

        sessionMapBackend: z.enum(["memory", "redis"]).default("memory"),
        sessionMapRedisUrl: z.string().url().optional(),
        sessionTtlS: z.coerce
            .number()
            .int()
            .positive()
            .default(60 * 60 * 24 * 7),

        host: z.string().default("0.0.0.0"),
        port: z.coerce.number().int().min(1).max(65535).default(9000),
        logLevel: z.enum(["trace", "debug", "info", "warn", "error", "silent"]).default("info"),

        // Observability
        tracingEnabled: z.coerce.boolean().default(false),
        otelServiceName: z.string().default("orchid-mcp"),
        otelExporterOtlpEndpoint: z.string().url().optional(),

        // Rate limiting
        rateLimitEnabled: z.coerce.boolean().default(true),
        rateLimitRpm: z.coerce.number().int().positive().default(60),
        rateLimitBurst: z.coerce.number().int().positive().default(30),

        // Circuit breaker
        circuitBreakerEnabled: z.coerce.boolean().default(true),
        circuitBreakerErrorThresholdPct: z.coerce.number().int().min(1).max(100).default(50),
        circuitBreakerResetMs: z.coerce.number().int().positive().default(30_000),
        circuitBreakerRollingWindowMs: z.coerce.number().int().positive().default(10_000),

        // Streaming (Phase 9) — opt-in; falls back to non-streaming sendMessage
        // whenever the MCP client doesn't supply a progressToken.
        streamingEnabled: z.coerce.boolean().default(false),
        /** Minimum ms between progress notifications (coalesces token bursts). */
        streamingProgressIntervalMs: z.coerce.number().int().nonnegative().default(50),

        iUnderstandTheRisk: z.coerce.boolean().default(false),
    })
    .strict();

export type Settings = z.infer<typeof SettingsSchema>;

const ENV_PREFIX = "ORCHID_MCP_";

function snakeToCamel(snake: string): string {
    return snake
        .toLowerCase()
        .split("_")
        .map((part, idx) => (idx === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join("");
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
    const raw: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(env)) {
        if (!key.startsWith(ENV_PREFIX) || value === undefined) {
            continue;
        }
        const camel = snakeToCamel(key.slice(ENV_PREFIX.length));
        raw[camel] = value;
    }
    return SettingsSchema.parse(raw);
}
