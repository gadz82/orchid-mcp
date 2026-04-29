/**
 * HTTP client for orchid-api's ``/mcp-gateway/state/*`` endpoints.
 *
 * Phase 3 of the auth-centralisation roadmap.  In earlier phases the
 * gateway kept its DCR client registrations, in-flight auth codes, and
 * issued access / refresh tokens in process memory or in local JSON
 * files.  Both strategies are single-replica by construction — two
 * gateway replicas behind a load balancer can't see each other's state.
 *
 * This module talks to a central orchid-api store (shared DB with
 * chat + outbound MCP tokens) so multi-replica gateway deployments
 * share the same registrations + codes + tokens.  Callers consume
 * three narrow ``*Store`` interfaces (see ``httpStores.ts``) — this
 * client is the single HTTP-layer dependency underneath all three.
 *
 * Auth model: every request carries
 * ``Authorization: Bearer <mcpGatewayStateServiceToken>`` — a shared
 * secret between the gateway and orchid-api.  Payloads carry live
 * access tokens and PKCE verifiers; operators can layer mTLS / allow
 * lists at the reverse-proxy tier for defence-in-depth.
 *
 * Wire schemas below mirror the Pydantic DTOs in
 * :file:`orchid-api/orchid_api/routers/mcp_gateway_state.py` — a
 * rename on either side surfaces as a clean zod parse error rather
 * than silent corruption.  Field names follow Python's snake_case
 * convention verbatim; the store wrappers handle ↔ camelCase
 * translation for the :type:`AuthCodeRecord` / :type:`GatewayTokenRecord`
 * shapes that TypeScript code works with.
 */

import { z } from "zod";

import {
    OrchidGatewayError,
    OrchidResponseShapeError,
    OrchidServerError,
    OrchidTimeoutError,
    OrchidUnauthorizedError,
} from "../errors.js";
import { getRequestId } from "../observability/correlation.js";
import { isTimeoutLike } from "../http/undiciOrchidClient.js";

import type { OrchidIdentity } from "./base.js";

import type {
    AuthCodeRecord,
    GatewayTokenRecord,
    RegisteredClient,
} from "./stores.js";

/* ── Wire schemas (mirror orchid-api DTOs) ───────────────────── */

export const WireGatewayClientSchema = z.object({
    client_id: z.string(),
    redirect_uris: z.array(z.string()),
    grant_types: z.array(z.string()),
    response_types: z.array(z.string()),
    token_endpoint_auth_method: z.string().default("none"),
    client_name: z.string().default(""),
    created_at: z.number(),
});
export type WireGatewayClient = z.infer<typeof WireGatewayClientSchema>;

export const WireGatewayAuthCodeSchema = z.object({
    code: z.string(),
    client_id: z.string(),
    redirect_uri: z.string(),
    code_challenge: z.string(),
    code_challenge_method: z.string(),
    upstream_state: z.string(),
    upstream_code_verifier: z.string(),
    scopes: z.array(z.string()),
    client_state: z.string().default(""),
    identity: z.record(z.unknown()).nullable().default(null),
    idp_access_token: z.string().default(""),
    idp_refresh_token: z.string().default(""),
    idp_expires_at: z.number().default(0),
    created_at: z.number(),
});
export type WireGatewayAuthCode = z.infer<typeof WireGatewayAuthCodeSchema>;

export const WireGatewayTokenSchema = z.object({
    access_token: z.string(),
    refresh_token: z.string(),
    client_id: z.string(),
    subject: z.string(),
    identity: z.record(z.unknown()),
    scopes: z.array(z.string()),
    expires_at: z.number(),
    // Phase 4 upstream-token fields — defaults keep the zod parse
    // green when pointed at a pre-Phase-4 orchid-api instance that
    // omits the fields entirely.
    idp_access_token: z.string().default(""),
    idp_refresh_token: z.string().default(""),
    idp_expires_at: z.number().default(0),
});
export type WireGatewayToken = z.infer<typeof WireGatewayTokenSchema>;

/* ── GatewayStateClient interface ───────────────────────────── */

export interface GatewayAuthCodePatch {
    identity?: Record<string, unknown>;
    idpAccessToken?: string;
    idpRefreshToken?: string;
    idpExpiresAt?: number;
}

/**
 * Narrow interface for the orchid-api gateway-state endpoints.  The
 * three persistence interfaces (:type:`ClientStore`,
 * :type:`AuthCodeStore`, :type:`GatewayTokenStore`) wrap one instance
 * of this client — consumers depend on whichever store fits their
 * concern rather than on this interface directly, preserving
 * interface segregation.
 */
export interface GatewayStateClient {
    // Clients
    registerClient(record: RegisteredClient): Promise<void>;
    getClient(clientId: string): Promise<RegisteredClient | null>;

    // Auth codes
    putAuthCode(record: AuthCodeRecord): Promise<void>;
    getAuthCodeByUpstreamState(upstreamState: string): Promise<AuthCodeRecord | null>;
    updateAuthCode(code: string, patch: GatewayAuthCodePatch): Promise<void>;
    consumeAuthCode(code: string): Promise<AuthCodeRecord | null>;

    // Tokens
    issueToken(record: GatewayTokenRecord): Promise<void>;
    getTokenByAccessToken(accessToken: string): Promise<GatewayTokenRecord | null>;
    getTokenByRefreshToken(refreshToken: string): Promise<GatewayTokenRecord | null>;
    revokeToken(accessToken: string): Promise<void>;
}

/* ── Concrete HTTP implementation ────────────────────────────── */

export interface HttpGatewayStateClientOptions {
    baseUrl: string;
    serviceToken: string;
    timeoutMs: number;
    /** Test-only override — defaults to global :any:`fetch`. */
    fetchImpl?: typeof fetch;
}

interface RequestSpec {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: string;
}

/**
 * Concrete :type:`GatewayStateClient` implemented against Node's
 * global ``fetch``.  Mirrors the error-mapping contract of
 * :class:`UndiciOrchidAPIClient` so callers see the same exception
 * types regardless of which client they're using:
 *
 * - ``OrchidUnauthorizedError`` on 401/403 — the service token is wrong.
 * - ``OrchidServerError`` on any other non-2xx — upstream problem.
 * - ``OrchidTimeoutError`` when the request exceeds ``timeoutMs``.
 * - ``OrchidResponseShapeError`` when zod parsing fails (orchid-api
 *   shape changed underfoot).
 *
 * 404 is treated per-endpoint as "row not found" (returns ``null``)
 * rather than an error — mirrors the in-memory / file stores.
 */
export class HttpGatewayStateClient implements GatewayStateClient {
    private readonly baseUrl: string;
    private readonly serviceToken: string;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: HttpGatewayStateClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/$/, "");
        this.serviceToken = opts.serviceToken;
        this.timeoutMs = opts.timeoutMs;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    // ── Clients ─────────────────────────────────────────────

    async registerClient(record: RegisteredClient): Promise<void> {
        await this.perform({
            method: "POST",
            path: "/mcp-gateway/state/clients",
            body: JSON.stringify(toWireClient(record)),
        });
    }

    async getClient(clientId: string): Promise<RegisteredClient | null> {
        const raw = await this.performWithNotFound({
            method: "GET",
            path: `/mcp-gateway/state/clients/${encodeURIComponent(clientId)}`,
        });
        if (raw === null) return null;
        return fromWireClient(this.parse(WireGatewayClientSchema, raw));
    }

    // ── Auth codes ──────────────────────────────────────────

    async putAuthCode(record: AuthCodeRecord): Promise<void> {
        await this.perform({
            method: "POST",
            path: "/mcp-gateway/state/auth-codes",
            body: JSON.stringify(toWireAuthCode(record)),
        });
    }

    async getAuthCodeByUpstreamState(upstreamState: string): Promise<AuthCodeRecord | null> {
        const raw = await this.performWithNotFound({
            method: "POST",
            path: "/mcp-gateway/state/auth-codes/lookup-by-upstream-state",
            body: JSON.stringify({ upstream_state: upstreamState }),
        });
        if (raw === null) return null;
        return fromWireAuthCode(this.parse(WireGatewayAuthCodeSchema, raw));
    }

    async updateAuthCode(code: string, patch: GatewayAuthCodePatch): Promise<void> {
        const body: Record<string, unknown> = {};
        if (patch.identity !== undefined) body.identity = patch.identity;
        if (patch.idpAccessToken !== undefined) body.idp_access_token = patch.idpAccessToken;
        if (patch.idpRefreshToken !== undefined) body.idp_refresh_token = patch.idpRefreshToken;
        if (patch.idpExpiresAt !== undefined) body.idp_expires_at = patch.idpExpiresAt;
        await this.perform({
            method: "PATCH",
            path: `/mcp-gateway/state/auth-codes/${encodeURIComponent(code)}`,
            body: JSON.stringify(body),
        });
    }

    async consumeAuthCode(code: string): Promise<AuthCodeRecord | null> {
        const raw = await this.performWithNotFound({
            method: "POST",
            path: `/mcp-gateway/state/auth-codes/${encodeURIComponent(code)}/consume`,
        });
        if (raw === null) return null;
        return fromWireAuthCode(this.parse(WireGatewayAuthCodeSchema, raw));
    }

    // ── Tokens ──────────────────────────────────────────────

    async issueToken(record: GatewayTokenRecord): Promise<void> {
        await this.perform({
            method: "POST",
            path: "/mcp-gateway/state/tokens",
            body: JSON.stringify(toWireToken(record)),
        });
    }

    async getTokenByAccessToken(accessToken: string): Promise<GatewayTokenRecord | null> {
        const raw = await this.performWithNotFound({
            method: "POST",
            path: "/mcp-gateway/state/tokens/introspect",
            body: JSON.stringify({ access_token: accessToken }),
        });
        if (raw === null) return null;
        return fromWireToken(this.parse(WireGatewayTokenSchema, raw));
    }

    async getTokenByRefreshToken(refreshToken: string): Promise<GatewayTokenRecord | null> {
        const raw = await this.performWithNotFound({
            method: "POST",
            path: "/mcp-gateway/state/tokens/introspect",
            body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (raw === null) return null;
        return fromWireToken(this.parse(WireGatewayTokenSchema, raw));
    }

    async revokeToken(accessToken: string): Promise<void> {
        // 204 on success, 204 even if the token wasn't there — the
        // server-side ``revoke`` is idempotent by design.
        await this.perform({
            method: "DELETE",
            path: `/mcp-gateway/state/tokens/${encodeURIComponent(accessToken)}`,
        });
    }

    // ── Internals ──────────────────────────────────────────

    private async perform(req: RequestSpec): Promise<unknown> {
        return this.request(req, /* allowNotFound */ false);
    }

    private async performWithNotFound(req: RequestSpec): Promise<unknown | null> {
        return this.request(req, /* allowNotFound */ true);
    }

    private async request(req: RequestSpec, allowNotFound: boolean): Promise<unknown> {
        const url = `${this.baseUrl}${req.path}`;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.serviceToken}`,
            Accept: "application/json",
        };
        if (req.body !== undefined) {
            headers["Content-Type"] = "application/json";
        }
        const requestId = getRequestId();
        if (requestId !== undefined) {
            headers["X-Request-ID"] = requestId;
        }

        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method: req.method,
                headers,
                body: req.body ?? null,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            if (isTimeoutLike(err)) {
                throw new OrchidTimeoutError(
                    `Upstream timed out after ${String(this.timeoutMs)}ms: ${req.method} ${req.path}`,
                );
            }
            throw new OrchidGatewayError(
                `Upstream request failed (${req.method} ${req.path}): ${errorMessage(err)}`,
            );
        }

        const status = response.status;

        if (status === 204) return null;
        if (status === 404 && allowNotFound) return null;
        if (status === 401 || status === 403) {
            throw new OrchidUnauthorizedError(
                `Upstream rejected gateway-state service token: ${String(status)} on ${req.method} ${req.path}`,
            );
        }

        const text = await response.text();
        let parsed: unknown = null;
        if (text.length > 0) {
            try {
                parsed = JSON.parse(text);
            } catch {
                if (status >= 200 && status < 300) {
                    throw new OrchidResponseShapeError(
                        `Non-JSON response body from ${req.method} ${req.path}`,
                    );
                }
                parsed = text;
            }
        }

        if (status < 200 || status >= 300) {
            throw new OrchidServerError(
                `Upstream returned ${String(status)} on ${req.method} ${req.path}`,
                status,
                parsed,
            );
        }
        return parsed;
    }

    private parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
        const result = schema.safeParse(body);
        if (!result.success) {
            throw new OrchidResponseShapeError(
                `Upstream gateway-state response shape invalid: ${result.error.message}`,
            );
        }
        return result.data;
    }
}

/* ── Wire ↔ record converters ────────────────────────────── */

function toWireClient(record: RegisteredClient): WireGatewayClient {
    return {
        client_id: record.client_id,
        redirect_uris: record.redirect_uris,
        grant_types: record.grant_types,
        response_types: record.response_types,
        token_endpoint_auth_method: record.token_endpoint_auth_method,
        client_name: record.client_name ?? "",
        created_at: record.created_at,
    };
}

function fromWireClient(wire: WireGatewayClient): RegisteredClient {
    return {
        client_id: wire.client_id,
        redirect_uris: wire.redirect_uris,
        grant_types: wire.grant_types,
        response_types: wire.response_types,
        token_endpoint_auth_method: "none",
        client_name: wire.client_name,
        created_at: wire.created_at,
    };
}

function toWireAuthCode(record: AuthCodeRecord): WireGatewayAuthCode {
    return {
        code: record.code,
        client_id: record.clientId,
        redirect_uri: record.redirectUri,
        code_challenge: record.codeChallenge,
        code_challenge_method: record.codeChallengeMethod,
        upstream_state: record.upstreamState,
        upstream_code_verifier: record.upstreamCodeVerifier,
        scopes: record.scopes,
        client_state: record.clientState ?? "",
        identity: (record.identity as Record<string, unknown> | undefined) ?? null,
        idp_access_token: record.idpAccessToken ?? "",
        idp_refresh_token: record.idpRefreshToken ?? "",
        idp_expires_at: record.idpExpiresAt ?? 0,
        created_at: record.createdAt,
    };
}

function fromWireAuthCode(wire: WireGatewayAuthCode): AuthCodeRecord {
    const record: AuthCodeRecord = {
        code: wire.code,
        clientId: wire.client_id,
        redirectUri: wire.redirect_uri,
        codeChallenge: wire.code_challenge,
        codeChallengeMethod: "S256",
        upstreamState: wire.upstream_state,
        upstreamCodeVerifier: wire.upstream_code_verifier,
        scopes: wire.scopes,
        createdAt: wire.created_at,
    };
    if (wire.client_state.length > 0) record.clientState = wire.client_state;
    if (wire.identity !== null) {
        // orchid-api stores identity as an opaque dict; ``recordToIdentity``
        // validates the shape via Zod so a wire-side rename (or a stale
        // row written by an older gateway version) surfaces as a clear
        // error instead of an AttributeError when something later reads
        // ``identity.bearer``.
        record.identity = recordToIdentity(wire.identity);
    }
    if (wire.idp_access_token.length > 0) record.idpAccessToken = wire.idp_access_token;
    if (wire.idp_refresh_token.length > 0) record.idpRefreshToken = wire.idp_refresh_token;
    if (wire.idp_expires_at > 0) record.idpExpiresAt = wire.idp_expires_at;
    return record;
}

/**
 * Schema for the on-the-wire ``identity`` payload — matches the
 * :class:`OrchidIdentity` shape from :mod:`./base`. Kept here next to
 * the other wire schemas so a rename on either side surfaces as a
 * clear Zod error instead of a runtime AttributeError downstream.
 */
const WireOrchidIdentitySchema = z.object({
    bearer: z.string(),
    subject: z.string(),
    authDomain: z.string().optional(),
});

/** Widen :class:`OrchidIdentity` to a JSON record without a blind ``as`` cast. */
export function identityToRecord(identity: OrchidIdentity): Record<string, unknown> {
    const record: Record<string, unknown> = {
        bearer: identity.bearer,
        subject: identity.subject,
    };
    if (identity.authDomain !== undefined) {
        record.authDomain = identity.authDomain;
    }
    return record;
}

/** Validate a wire record and narrow it to :class:`OrchidIdentity`. */
export function recordToIdentity(record: Record<string, unknown>): OrchidIdentity {
    const parsed = WireOrchidIdentitySchema.safeParse(record);
    if (!parsed.success) {
        throw new OrchidResponseShapeError(
            `Upstream identity payload is malformed: ${parsed.error.message}`,
        );
    }
    const identity: OrchidIdentity = {
        bearer: parsed.data.bearer,
        subject: parsed.data.subject,
    };
    if (parsed.data.authDomain !== undefined) {
        identity.authDomain = parsed.data.authDomain;
    }
    return identity;
}

function toWireToken(record: GatewayTokenRecord): WireGatewayToken {
    return {
        access_token: record.accessToken,
        refresh_token: record.refreshToken,
        client_id: record.clientId,
        subject: record.subject,
        identity: identityToRecord(record.identity),
        scopes: record.scopes,
        expires_at: record.expiresAt,
        idp_access_token: record.idpAccessToken ?? "",
        idp_refresh_token: record.idpRefreshToken ?? "",
        idp_expires_at: record.idpExpiresAt ?? 0,
    };
}

function fromWireToken(wire: WireGatewayToken): GatewayTokenRecord {
    const record: GatewayTokenRecord = {
        accessToken: wire.access_token,
        refreshToken: wire.refresh_token,
        clientId: wire.client_id,
        subject: wire.subject,
        identity: recordToIdentity(wire.identity),
        scopes: wire.scopes,
        expiresAt: wire.expires_at,
    };
    // Only surface optional fields when the upstream actually
    // populated them — otherwise leaving them ``undefined`` makes
    // the "no refresh token was issued" branch straightforward on
    // the refresh path.
    if (wire.idp_access_token.length > 0) record.idpAccessToken = wire.idp_access_token;
    if (wire.idp_refresh_token.length > 0) record.idpRefreshToken = wire.idp_refresh_token;
    if (wire.idp_expires_at > 0) record.idpExpiresAt = wire.idp_expires_at;
    return record;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
