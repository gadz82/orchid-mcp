import type { AuthStrategy, OrchidIdentity } from "./auth/base.js";
import { HttpGatewayStateClient } from "./auth/gatewayStateClient.js";
import { buildHttpStoreSet } from "./auth/httpStores.js";
import { MCPOAuthStrategy } from "./auth/oauth.js";
import { ServiceAccountStrategy, guardServiceAccountDeployment } from "./auth/serviceAccount.js";
import {
    MemoryAuthCodeStore,
    MemoryClientStore,
    MemoryGatewayTokenStore,
    type AuthCodeStore,
    type ClientStore,
    type GatewayTokenStore,
} from "./auth/stores.js";
import { applyUpstreamDiscovery } from "./auth/upstreamDiscovery.js";
import { verifyUpstreamAuthPosture } from "./auth/upstreamPosture.js";
import type { AppContext } from "./context.js";
import { OrchidConfigError } from "./errors.js";
import { CircuitBreakerOrchidAPIClient } from "./http/circuitBreaker.js";
import type { OrchidAPIClient, UpstreamTokenResponse } from "./http/orchidClient.js";
import { UndiciOrchidAPIClient } from "./http/undiciOrchidClient.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { shutdownTracing, startTracing } from "./observability/tracing.js";
import { NoopRateLimiter, TokenBucketRateLimiter, type RateLimiter } from "./rateLimit.js";
import { buildServer } from "./server.js";
import { MemorySessionMap } from "./sessions/memory.js";
import { loadSettings, type Settings } from "./settings.js";

async function buildAuthStrategy(
    settings: Settings,
    logger: Logger,
    httpClient: OrchidAPIClient,
): Promise<AuthStrategy> {
    if (settings.authMode === "service_account") {
        const opts: ConstructorParameters<typeof ServiceAccountStrategy>[0] = {
            serviceAccountToken: settings.serviceAccountToken ?? "",
        };
        if (settings.serviceAccountAuthDomain !== undefined) {
            opts.serviceAccountAuthDomain = settings.serviceAccountAuthDomain;
        }
        return new ServiceAccountStrategy(opts);
    }
    // authMode === "oauth"
    const {
        oauthIssuerUrl,
        oauthAuthorizationEndpoint,
        oauthClientId,
        oauthScopes,
        oauthGatewayBaseUrl,
        oauthTokenTtlS,
        oauthClientRegistrationEnabled,
    } = settings;
    if (
        oauthIssuerUrl === undefined ||
        oauthAuthorizationEndpoint === undefined ||
        oauthClientId === undefined ||
        oauthGatewayBaseUrl === undefined
    ) {
        throw new OrchidConfigError(
            "OAuth mode requires ORCHID_MCP_OAUTH_ISSUER_URL, " +
                "ORCHID_MCP_OAUTH_AUTHORIZATION_ENDPOINT, " +
                "ORCHID_MCP_OAUTH_CLIENT_ID, and ORCHID_MCP_OAUTH_GATEWAY_BASE_URL " +
                "to be set.  ``token_endpoint`` and ``userinfo_endpoint`` are no " +
                "longer needed on the gateway side — both are owned by orchid-api " +
                "(Phase 5 of the auth-centralisation roadmap).",
        );
    }

    // Pick the gateway-state backend:
    //   - ``memory`` (default) — single-process, fine for unit tests
    //     and single-replica personal deploys; state evaporates on
    //     restart.
    //   - ``http`` — delegates to orchid-api's
    //     ``/mcp-gateway/state/*`` endpoints so multiple gateway
    //     replicas share one source of truth (Phase 3).
    //
    // The ``file`` backend was retired in Phase 4 — operators who
    // need cross-restart persistence should point the gateway at
    // orchid-api's ``http`` backend (same durability guarantee, no
    // local disk footprint).  Setting ``ORCHID_MCP_OAUTH_STORE_BACKEND=file``
    // now surfaces as a settings validation error at load time.
    const resolvedBackend: "memory" | "http" = settings.oauthStoreBackend ?? "memory";

    let clientStore: ClientStore;
    let authCodeStore: AuthCodeStore;
    let tokenStore: GatewayTokenStore;
    if (resolvedBackend === "http") {
        if (
            settings.gatewayStateServiceToken === undefined ||
            settings.gatewayStateServiceToken.length === 0
        ) {
            throw new OrchidConfigError(
                "ORCHID_MCP_OAUTH_STORE_BACKEND=http requires ORCHID_MCP_GATEWAY_STATE_SERVICE_TOKEN to be set " +
                    "(must match orchid-api's MCP_GATEWAY_STATE_SERVICE_TOKEN).",
            );
        }
        const gatewayStateClient = new HttpGatewayStateClient({
            baseUrl: settings.orchidApiUrl,
            serviceToken: settings.gatewayStateServiceToken,
            timeoutMs: settings.orchidApiTimeoutMs,
        });
        const stores = buildHttpStoreSet(gatewayStateClient);
        clientStore = stores.clientStore;
        authCodeStore = stores.authCodeStore;
        tokenStore = stores.tokenStore;
        logger.info(
            { orchidApiUrl: settings.orchidApiUrl },
            "OAuth state persisted to orchid-api /mcp-gateway/state (http backend)",
        );
    } else {
        clientStore = new MemoryClientStore();
        authCodeStore = new MemoryAuthCodeStore();
        tokenStore = new MemoryGatewayTokenStore({ ttlSeconds: oauthTokenTtlS });
    }

    // Phase 5 — every upstream call is centralised on orchid-api.
    // The gateway holds no ``client_secret``, no userinfo URL, no
    // JSON-path hints; it simply forwards the upstream access /
    // refresh tokens to orchid-api and uses whatever the server
    // returns.  All three delegates are wired unconditionally so
    // there's no "fallback path" to surprise an operator who
    // changed their config but missed an env var.

    const exchangeUpstreamCode = async (params: {
        code: string;
        redirect_uri: string;
        code_verifier: string;
    }): Promise<{
        access_token: string;
        refresh_token?: string;
        token_type?: string;
        scope?: string;
        expires_at?: number;
    }> => {
        // Empty bearer — ``/auth/exchange-code`` is unauthenticated
        // on the server side (PKCE + upstream code binding provide
        // the natural protection).
        const response = await httpClient.exchangeAuthorizationCode(
            { bearer: "" },
            params,
        );
        return normaliseUpstreamTokenResponse(response);
    };

    const resolveIdentityDelegate = async (accessToken: string) => {
        const response = await httpClient.resolveIdentity({
            access_token: accessToken,
            ...(settings.oauthAuthDomain !== undefined
                ? { auth_domain: settings.oauthAuthDomain }
                : {}),
        });
        const identity: OrchidIdentity = {
            bearer: response.bearer,
            subject: response.subject,
        };
        if (response.auth_domain.length > 0) {
            identity.authDomain = response.auth_domain;
        }
        return identity;
    };

    const refreshUpstreamToken = async (idpRefreshToken: string) => {
        const response = await httpClient.refreshUpstreamToken(
            { bearer: "" },
            { refresh_token: idpRefreshToken },
        );
        return normaliseUpstreamTokenResponse(response);
    };

    return new MCPOAuthStrategy({
        logger,
        gatewayBaseUrl: oauthGatewayBaseUrl,
        tokenTtlS: oauthTokenTtlS,
        clientRegistrationEnabled: oauthClientRegistrationEnabled,
        idp: {
            issuer: oauthIssuerUrl,
            authorizationEndpoint: oauthAuthorizationEndpoint,
            clientId: oauthClientId,
            scopes: oauthScopes,
            ...(settings.oauthAuthDomain !== undefined
                ? { authDomain: settings.oauthAuthDomain }
                : {}),
        },
        clientStore,
        authCodeStore,
        tokenStore,
        exchangeUpstreamCode,
        resolveIdentity: resolveIdentityDelegate,
        refreshUpstreamToken,
    });
}

/**
 * Translate an :type:`UpstreamTokenResponse` (RFC 6749 §5.1 shape)
 * into the gateway-internal :type:`IdPTokens` shape consumed by
 * :class:`MCPOAuthStrategy`.  ``expires_in`` (relative seconds from
 * the upstream) becomes ``expires_at`` (absolute, seconds since
 * epoch) so downstream consumers don't have to track when the
 * response arrived.
 *
 * The ``Partial`` shape on the input mirrors zod's
 * ``UpstreamTokenResponse`` — the .optional() fields can be
 * literally absent from the object, but ``exactOptionalPropertyTypes``
 * forbids us from assigning a ``T | undefined`` to a ``T?`` slot.
 * The spread-only-when-defined dance below threads that needle.
 */
function normaliseUpstreamTokenResponse(
    response: UpstreamTokenResponse,
): {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
    expires_at?: number;
} {
    const tokens: {
        access_token: string;
        refresh_token?: string;
        token_type?: string;
        scope?: string;
        expires_at?: number;
    } = { access_token: response.access_token };
    if (response.refresh_token !== undefined) tokens.refresh_token = response.refresh_token;
    if (response.token_type !== undefined) tokens.token_type = response.token_type;
    if (response.scope !== undefined) tokens.scope = response.scope;
    if (response.expires_in !== undefined) {
        tokens.expires_at = Math.floor(Date.now() / 1000) + response.expires_in;
    }
    return tokens;
}

function buildRateLimiter(settings: Settings): RateLimiter {
    if (!settings.rateLimitEnabled) return new NoopRateLimiter();
    return new TokenBucketRateLimiter({
        rpm: settings.rateLimitRpm,
        burst: settings.rateLimitBurst,
    });
}

function buildHttpClient(settings: Settings, logger: Logger): OrchidAPIClient {
    const base = new UndiciOrchidAPIClient({
        baseUrl: settings.orchidApiUrl,
        timeoutMs: settings.orchidApiTimeoutMs,
    });
    if (!settings.circuitBreakerEnabled) return base;
    return new CircuitBreakerOrchidAPIClient({
        inner: base,
        logger,
        config: {
            errorThresholdPercentage: settings.circuitBreakerErrorThresholdPct,
            resetTimeoutMs: settings.circuitBreakerResetMs,
            rollingWindowMs: settings.circuitBreakerRollingWindowMs,
        },
    });
}

async function main(): Promise<void> {
    let settings = loadSettings();
    const logger = createLogger(settings.logLevel);

    await startTracing({
        serviceName: settings.otelServiceName,
        ...(settings.tracingEnabled && settings.otelExporterOtlpEndpoint !== undefined
            ? { otlpEndpoint: settings.otelExporterOtlpEndpoint }
            : {}),
        logger,
    });

    guardServiceAccountDeployment({
        authMode: settings.authMode,
        host: settings.host,
        iUnderstandTheRisk: settings.iUnderstandTheRisk,
    });

    // Build the HTTP client BEFORE the auth strategy: ``discover`` mode
    // needs to fetch ``/auth-info`` from orchid-api to learn which
    // OAuth endpoints + public client_id to configure the strategy
    // with.  Non-discover modes pass through unchanged.
    const httpClient = buildHttpClient(settings, logger);
    settings = await applyUpstreamDiscovery(settings, httpClient, logger);

    const authStrategy = await buildAuthStrategy(settings, logger, httpClient);

    // Probe upstream /auth-info — fatal when gateway auth-mode mismatches
    // upstream requirements (e.g. service_account against a dev_bypass=false
    // orchid-api); log-only when the combination is merely suboptimal or
    // when the probe can't reach the upstream.  After ``discover``
    // resolution the mode is always one of the narrow two posture
    // values, so the cast is safe.
    if (settings.authMode !== "discover") {
        await verifyUpstreamAuthPosture(httpClient, settings.authMode, logger);
    }

    const sessionMap = new MemorySessionMap({ ttlSeconds: settings.sessionTtlS });
    const rateLimiter = buildRateLimiter(settings);

    const ctx: AppContext = {
        settings,
        logger,
        httpClient,
        sessionMap,
        authStrategy,
        rateLimiter,
    };

    const { httpServer, close } = await buildServer({ ctx });

    httpServer.listen(settings.port, settings.host, () => {
        logger.info(
            {
                host: settings.host,
                port: settings.port,
                authMode: settings.authMode,
                orchidApiUrl: settings.orchidApiUrl,
            },
            "orchid-mcp listening",
        );
    });

    const shutdown = (signal: string): void => {
        logger.info({ signal }, "shutting down");
        httpServer.close();
        Promise.all([close(), httpClient.close(), shutdownTracing()]).then(
            () => {
                process.exit(0);
            },
            (err: unknown) => {
                logger.error({ err }, "shutdown failed");
                process.exit(1);
            },
        );
    };

    process.on("SIGTERM", () => {
        shutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
        shutdown("SIGINT");
    });
}

main().catch((err: unknown) => {
    console.error("orchid-mcp failed to start:", err);
    process.exit(1);
});
