/**
 * MCP 2025-03-26 OAuth 2.0 authorization-server role.
 *
 * :class:`MCPOAuthStrategy` is both:
 *   - the :class:`AuthStrategy` that verifies incoming MCP bearer tokens
 *     against the gateway's own token store
 *   - the owner of six HTTP routes (metadata, DCR, authorize, callback,
 *     token, revoke-stub) that make the gateway behave like a
 *     Dynamic-Client-Registration-capable OAuth AS to its MCP clients,
 *     while delegating the actual user authentication to a configured
 *     upstream OIDC IdP.
 *
 * The upstream side is fully delegated: a Phase-2
 * :type:`UpstreamExchangeDelegate` performs the secret-bearing
 * authorization-code exchange (orchid-api's ``/auth/exchange-code``),
 * a Phase-4 :type:`UpstreamIdentityDelegate` turns the resulting
 * access token into an :type:`OrchidIdentity` (orchid-api's
 * ``/auth/resolve-identity``), and an optional
 * :type:`UpstreamRefreshDelegate` rotates upstream tokens on gateway
 * refresh (orchid-api's ``/auth/refresh-token``).  We never verify
 * or store upstream ID tokens — gateway access tokens are opaque
 * UUIDs so there's nothing to sign.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "../observability/logger.js";

import type { AuthRoute, AuthStrategy, MCPRequestContext, OrchidIdentity } from "./base.js";
import { handleAuthorizationCodeGrant, handleRefreshTokenGrant } from "./oauth_token.js";
import {
    epochSeconds,
    errorMessage,
    queryParams,
    randomBase64Url,
    readFormBody,
    readJsonBody,
    sha256Base64Url,
    validateBaseUrl,
    writeJson,
} from "./oauth_utils.js";

/**
 * Normalised upstream-IdP token response.  Mirrors RFC 6749 §5.1
 * with one tweak: ``expires_at`` is absolute (seconds since epoch)
 * rather than relative — the downstream code uses it directly to
 * decide whether the upstream bearer is stale, with no clock-skew
 * arithmetic at the call site.
 */
export interface IdPTokens {
    access_token: string;
    refresh_token?: string;
    /** Seconds since epoch. */
    expires_at?: number;
    id_token?: string;
    token_type?: string;
    scope?: string;
}
import type {
    AuthCodeRecord,
    AuthCodeStore,
    ClientStore,
    GatewayTokenStore,
    RegisteredClient,
} from "./stores.js";

import { OrchidUnauthorizedError } from "../errors.js";

/** Upstream IdP configuration.
 *
 * Phase 5 minimum: ``issuer`` + ``authorizationEndpoint`` + ``clientId``
 * + ``scopes`` are needed to build the ``/authorize`` redirect URL the
 * gateway sends users to; ``authDomain`` is an optional hint passed
 * downstream.  Everything else (``tokenEndpoint``, ``userinfoEndpoint``,
 * ``clientSecret``, JSON-path hints) was retired when Phases 2–4
 * centralised the secret-bearing exchange + identity resolution +
 * refresh on the orchid-api side.
 */
export interface UpstreamIdPConfig {
    issuer: string;
    authorizationEndpoint: string;
    clientId: string;
    scopes: string;
    /**
     * Platform domain (e.g. ``mytenant.example.com``) the gateway
     * forwards to orchid-api when calling
     * ``/auth/resolve-identity`` so multi-tenant deployments resolve
     * the right tenant.  ``undefined`` lets orchid-api fall back to
     * its operator-level default (``settings.auth_domain``).
     */
    authDomain?: string;
}

/**
 * Delegate for the upstream ``grant_type=authorization_code`` exchange.
 *
 * Default implementation POSTs to ``idp.tokenEndpoint`` with
 * ``client_id`` + ``client_secret`` + PKCE verifier — the Phase 1
 * behaviour where the gateway holds ``client_secret`` itself.
 *
 * Phase 2 operators inject an alternative that delegates to
 * orchid-api's ``POST /auth/exchange-code``, moving the secret off
 * the gateway entirely.  Injection wiring lives in :mod:`src/index.ts`.
 */
export type UpstreamExchangeDelegate = (params: {
    code: string;
    redirect_uri: string;
    code_verifier: string;
}) => Promise<IdPTokens>;

/**
 * Delegate for identity resolution.  The strategy calls this with
 * the upstream access token freshly obtained via
 * :type:`UpstreamExchangeDelegate` and stores the returned
 * :type:`OrchidIdentity` on the pending auth-code record.  Wiring
 * lives in :mod:`src/index.ts`, which builds the delegate from
 * ``orchid-api``'s ``/auth/resolve-identity`` endpoint.
 */
export type UpstreamIdentityDelegate = (
    accessToken: string,
) => Promise<OrchidIdentity>;

/**
 * Delegate for the upstream ``grant_type=refresh_token`` exchange.
 *
 * Same opt-in shape as :type:`UpstreamExchangeDelegate` but for
 * the refresh grant.  When wired, the gateway's
 * ``/token?grant_type=refresh_token`` handler kicks the upstream
 * refresh off via this delegate, swaps the stored
 * :attr:`GatewayTokenRecord.idpAccessToken` /
 * :attr:`GatewayTokenRecord.idpRefreshToken` pair, and mints a
 * fresh gateway pair with an identity that carries the new
 * upstream bearer.  Without it the refresh flow only rotates
 * gateway tokens — the upstream bearer stays stale and the
 * user eventually hits 401 on the next backend call.
 */
export type UpstreamRefreshDelegate = (
    refreshToken: string,
) => Promise<IdPTokens>;

/** Everything the strategy needs at runtime, injected from ``index.ts``. */
export interface MCPOAuthStrategyOptions {
    logger: Logger;
    gatewayBaseUrl: string;
    tokenTtlS: number;
    clientRegistrationEnabled: boolean;
    idp: UpstreamIdPConfig;
    clientStore: ClientStore;
    authCodeStore: AuthCodeStore;
    tokenStore: GatewayTokenStore;
    /** Hook for tests — fetch used for upstream IdP calls. */
    fetchImpl?: typeof fetch;
    /**
     * Performs the upstream ``grant_type=authorization_code``
     * exchange.  Phase 2 onwards this delegates to orchid-api's
     * ``/auth/exchange-code`` endpoint — the gateway no longer
     * holds ``client_secret``.
     */
    exchangeUpstreamCode: UpstreamExchangeDelegate;
    /**
     * Resolves an upstream access token into an
     * :type:`OrchidIdentity`.  Phase 4 onwards this delegates to
     * orchid-api's ``/auth/resolve-identity`` — the gateway no
     * longer needs ``userinfo_endpoint`` / JSON-path config.
     */
    resolveIdentity: UpstreamIdentityDelegate;
    /**
     * Optional delegate that performs the upstream refresh-token
     * exchange on behalf of the gateway (Phase 4).  When set,
     * ``tokenRefresh`` swaps the stored upstream tokens on every
     * gateway refresh instead of reusing the stale pair.  Left
     * optional because some IdPs don't issue refresh tokens at all
     * — in that case the gateway falls back to gateway-only
     * rotation, and the user eventually re-authenticates from
     * scratch.
     */
    refreshUpstreamToken?: UpstreamRefreshDelegate;
}

export class MCPOAuthStrategy implements AuthStrategy {
    readonly mode = "oauth" as const;

    private readonly opts: MCPOAuthStrategyOptions;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: MCPOAuthStrategyOptions) {
        validateBaseUrl(opts.gatewayBaseUrl);
        this.opts = opts;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    async resolve(ctx: MCPRequestContext): Promise<OrchidIdentity> {
        const token = ctx.accessToken;
        if (token === undefined || token.length === 0) {
            throw new OrchidUnauthorizedError(
                "Missing Bearer token. MCP clients must obtain one via the gateway's OAuth flow.",
            );
        }
        const record = await this.opts.tokenStore.getByAccessToken(token);
        if (record === null) {
            throw new OrchidUnauthorizedError("Unknown or revoked gateway access token.");
        }
        if (record.expiresAt * 1000 <= Date.now()) {
            await this.opts.tokenStore.revoke(token);
            throw new OrchidUnauthorizedError(
                "Gateway access token has expired. The client should refresh or re-authenticate.",
            );
        }
        return record.identity;
    }

    httpRoutes(): AuthRoute[] {
        const routes: AuthRoute[] = [
            {
                method: "GET",
                path: "/.well-known/oauth-authorization-server",
                handle: (req, res) => this.serveAsMetadata(req, res),
            },
            {
                method: "GET",
                path: "/.well-known/oauth-protected-resource",
                handle: (req, res) => this.serveResourceMetadata(req, res),
            },
            {
                method: "GET",
                path: "/authorize",
                handle: (req, res) => this.handleAuthorize(req, res),
            },
            {
                method: "GET",
                path: "/oauth/callback",
                handle: (req, res) => this.handleCallback(req, res),
            },
            {
                method: "POST",
                path: "/token",
                handle: (req, res) => this.handleToken(req, res),
            },
        ];
        if (this.opts.clientRegistrationEnabled) {
            routes.push({
                method: "POST",
                path: "/register",
                handle: (req, res) => this.handleRegister(req, res),
            });
        }
        return routes;
    }

    /* ── Metadata docs (RFC 8414 + RFC 9728) ─────────────────── */

    private serveAsMetadata(_req: IncomingMessage, res: ServerResponse): void {
        const base = this.opts.gatewayBaseUrl;
        const body: Record<string, unknown> = {
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            scopes_supported: this.opts.idp.scopes.split(/\s+/).filter(Boolean),
        };
        if (this.opts.clientRegistrationEnabled) {
            body.registration_endpoint = `${base}/register`;
        }
        writeJson(res, 200, body);
    }

    private serveResourceMetadata(_req: IncomingMessage, res: ServerResponse): void {
        const base = this.opts.gatewayBaseUrl;
        writeJson(res, 200, {
            resource: base,
            authorization_servers: [base],
            bearer_methods_supported: ["header"],
            scopes_supported: this.opts.idp.scopes.split(/\s+/).filter(Boolean),
            resource_name: "orchid-mcp",
        });
    }

    /* ── /register (RFC 7591 DCR) ────────────────────────────── */

    private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!this.opts.clientRegistrationEnabled) {
            writeJson(res, 404, { error: "not_found" });
            return;
        }
        const body = await readJsonBody(req);
        if (body === null || typeof body !== "object") {
            writeJson(res, 400, { error: "invalid_client_metadata" });
            return;
        }
        const raw = body as Record<string, unknown>;
        const redirectUris = Array.isArray(raw.redirect_uris)
            ? raw.redirect_uris.filter((u): u is string => typeof u === "string" && u.length > 0)
            : [];
        if (redirectUris.length === 0) {
            writeJson(res, 400, {
                error: "invalid_redirect_uri",
                error_description: "redirect_uris must be a non-empty array of strings.",
            });
            return;
        }
        const clientId = `mcp-${randomUUID()}`;
        const client: RegisteredClient = {
            client_id: clientId,
            redirect_uris: redirectUris,
            created_at: epochSeconds(),
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            ...(typeof raw.client_name === "string" ? { client_name: raw.client_name } : {}),
        };
        await this.opts.clientStore.register(client);
        writeJson(res, 201, client);
    }

    /* ── /authorize ──────────────────────────────────────────── */

    private async handleAuthorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const params = queryParams(req);
        const clientId = params.get("client_id");
        const redirectUri = params.get("redirect_uri");
        const responseType = params.get("response_type");
        const codeChallenge = params.get("code_challenge");
        const codeChallengeMethod = params.get("code_challenge_method") ?? "S256";
        const state = params.get("state") ?? undefined;
        const scope = params.get("scope") ?? this.opts.idp.scopes;

        if (clientId === null || redirectUri === null || codeChallenge === null) {
            writeJson(res, 400, {
                error: "invalid_request",
                error_description: "client_id, redirect_uri, and code_challenge are required.",
            });
            return;
        }
        if (responseType !== "code") {
            writeJson(res, 400, {
                error: "unsupported_response_type",
                error_description: "Only response_type=code is supported.",
            });
            return;
        }
        if (codeChallengeMethod !== "S256") {
            writeJson(res, 400, {
                error: "invalid_request",
                error_description: "Only code_challenge_method=S256 is supported.",
            });
            return;
        }
        const client = await this.opts.clientStore.get(clientId);
        if (client === null) {
            writeJson(res, 400, { error: "invalid_client" });
            return;
        }
        if (!client.redirect_uris.includes(redirectUri)) {
            writeJson(res, 400, { error: "invalid_redirect_uri" });
            return;
        }

        const code = `gw-${randomUUID()}`;
        const upstreamState = randomBase64Url(32);
        const upstreamVerifier = randomBase64Url(64);
        const upstreamChallenge = await sha256Base64Url(upstreamVerifier);

        const record: AuthCodeRecord = {
            code,
            clientId,
            redirectUri,
            codeChallenge,
            codeChallengeMethod: "S256",
            upstreamState,
            upstreamCodeVerifier: upstreamVerifier,
            scopes: scope.split(/\s+/).filter(Boolean),
            createdAt: epochSeconds(),
            ...(state !== undefined ? { clientState: state } : {}),
        };
        await this.opts.authCodeStore.put(record);

        const upstream = new URL(this.opts.idp.authorizationEndpoint);
        upstream.searchParams.set("client_id", this.opts.idp.clientId);
        upstream.searchParams.set("redirect_uri", this.gatewayCallbackUrl());
        upstream.searchParams.set("response_type", "code");
        upstream.searchParams.set("scope", this.opts.idp.scopes);
        upstream.searchParams.set("state", upstreamState);
        upstream.searchParams.set("code_challenge", upstreamChallenge);
        upstream.searchParams.set("code_challenge_method", "S256");

        res.writeHead(302, { Location: upstream.toString() });
        res.end();
    }

    /* ── /oauth/callback (upstream IdP lands here) ───────────── */

    private async handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const params = queryParams(req);
        const code = params.get("code");
        const upstreamState = params.get("state");
        const err = params.get("error");
        if (err !== null) {
            writeJson(res, 400, {
                error: err,
                error_description: params.get("error_description") ?? "",
            });
            return;
        }
        if (code === null || upstreamState === null) {
            writeJson(res, 400, { error: "invalid_request" });
            return;
        }
        const pending = await this.opts.authCodeStore.getByUpstreamState(upstreamState);
        if (pending === null) {
            writeJson(res, 400, { error: "invalid_state" });
            return;
        }

        // Exchange upstream code for IdP tokens via orchid-api's
        // ``/auth/exchange-code`` (Phase 2).  The gateway never
        // holds ``client_secret``.
        let tokens: IdPTokens;
        try {
            tokens = await this.opts.exchangeUpstreamCode({
                code,
                redirect_uri: this.gatewayCallbackUrl(),
                code_verifier: pending.upstreamCodeVerifier,
            });
        } catch (exchangeErr) {
            // Log only the error message — the raw ``err`` object can
            // carry tokens, request bodies, or stack traces from the
            // exchange client we don't want in pino's structured output.
            this.opts.logger.warn(
                { err: errorMessage(exchangeErr) },
                "upstream token exchange failed",
            );
            writeJson(res, 502, { error: "upstream_token_exchange_failed" });
            return;
        }

        // Resolve identity via orchid-api's ``/auth/resolve-identity``
        // (Phase 4) — the same :class:`OrchidIdentityResolver` that
        // validates every authenticated MCP request runs the call,
        // so no userinfo URL or JSON-path config lives on the
        // gateway.
        let identity: OrchidIdentity;
        try {
            identity = await this.opts.resolveIdentity(tokens.access_token);
        } catch (resolveErr) {
            this.opts.logger.error(
                { err: errorMessage(resolveErr) },
                "orchid-api identity resolver failed",
            );
            writeJson(res, 502, { error: "identity_resolver_failed" });
            return;
        }
        // Platform-domain override.  When discovery (or an explicit
        // env var) gave us a fixed platform domain, prefer it —
        // single-tenant deployments have ONE platform host and that
        // constant is the right value to pass downstream regardless
        // of whatever orchid-api's resolver reported (e.g. an
        // email-domain heuristic that produced ``acme.com`` from an
        // ``@acme.com`` employee email — the company domain doesn't
        // necessarily equal the tenant host).
        if (this.opts.idp.authDomain !== undefined && this.opts.idp.authDomain.length > 0) {
            identity.authDomain = this.opts.idp.authDomain;
        }

        const patch: Partial<AuthCodeRecord> = {
            identity,
            idpAccessToken: tokens.access_token,
        };
        if (tokens.refresh_token !== undefined) {
            patch.idpRefreshToken = tokens.refresh_token;
        }
        if (tokens.expires_at !== undefined) {
            patch.idpExpiresAt = tokens.expires_at;
        }
        await this.opts.authCodeStore.update(pending.code, patch);

        const redirect = new URL(pending.redirectUri);
        redirect.searchParams.set("code", pending.code);
        if (pending.clientState !== undefined) {
            redirect.searchParams.set("state", pending.clientState);
        }
        res.writeHead(302, { Location: redirect.toString() });
        res.end();
    }

    /* ── /token ──────────────────────────────────────────────── */

    private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const form = await readFormBody(req);
        if (form === null) {
            writeJson(res, 400, { error: "invalid_request" });
            return;
        }
        const grantType = form.get("grant_type");
        if (grantType === "authorization_code") {
            await handleAuthorizationCodeGrant(this.opts, form, res);
            return;
        }
        if (grantType === "refresh_token") {
            await handleRefreshTokenGrant(this.opts, form, res);
            return;
        }
        writeJson(res, 400, { error: "unsupported_grant_type" });
    }

    private gatewayCallbackUrl(): string {
        return `${this.opts.gatewayBaseUrl}/oauth/callback`;
    }
}

/* ── Backwards-compat re-export ────────────────────────────────── */

// ``readRawBody`` was exported (originally for test access) before the
// utility split. Forward the symbol so the existing
// ``test/readRawBody.test.ts`` keeps working without an import update.
export { readRawBody } from "./oauth_utils.js";
