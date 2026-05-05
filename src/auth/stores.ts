/**
 * In-memory stores backing the gateway's OAuth authorization-server role.
 *
 * Three narrow ABCs (Client / AuthCode / Token) with a default LRU-backed
 * implementation of each. All three are swappable — an operator running
 * multiple gateway replicas can plug a Redis implementation behind
 * these same interfaces without touching routing or strategy code.
 */

import { LRUCache } from "lru-cache";

import type { OrchidIdentity } from "./base.js";

/* ── Registered OAuth client (RFC 7591 DCR) ──────────────────── */

export interface RegisteredClient {
    client_id: string;
    client_name?: string;
    redirect_uris: string[];
    /** Seconds since epoch. */
    created_at: number;
    /** ``none`` for public PKCE-only clients; always ``none`` in v1. */
    token_endpoint_auth_method: "none";
    grant_types: string[];
    response_types: string[];
}

export interface ClientStore {
    register(client: RegisteredClient): Promise<void>;
    get(clientId: string): Promise<RegisteredClient | null>;
}

export class MemoryClientStore implements ClientStore {
    private readonly cache: LRUCache<string, RegisteredClient>;

    constructor(opts: { max?: number; ttlSeconds?: number } = {}) {
        this.cache = new LRUCache<string, RegisteredClient>({
            max: opts.max ?? 10_000,
            ...(opts.ttlSeconds !== undefined ? { ttl: opts.ttlSeconds * 1000 } : {}),
            perf: Date,
        });
    }

    async register(client: RegisteredClient): Promise<void> {
        this.cache.set(client.client_id, client);
    }

    async get(clientId: string): Promise<RegisteredClient | null> {
        return this.cache.get(clientId) ?? null;
    }
}

/* ── Pending authorization (state between /authorize and /callback) ──── */

export interface AuthCodeRecord {
    /** Gateway-issued authorization code (returned to the MCP client). */
    code: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    /** Upstream IdP state we're tracking (for correlation). */
    upstreamState: string;
    /** Upstream IdP PKCE verifier so ``/callback`` can complete the exchange. */
    upstreamCodeVerifier: string;
    /** State the MCP client sent; returned verbatim on redirect. */
    clientState?: string;
    scopes: string[];
    /** Filled in ``/callback`` once the identity bridge resolved the user. */
    identity?: OrchidIdentity;
    /** IdP-issued access token, kept for optional refresh flows. */
    idpAccessToken?: string;
    idpRefreshToken?: string;
    idpExpiresAt?: number;
    /** Seconds since epoch. */
    createdAt: number;
}

export interface AuthCodeStore {
    put(record: AuthCodeRecord): Promise<void>;
    /** Look up by the upstream state (used during /callback). */
    getByUpstreamState(upstreamState: string): Promise<AuthCodeRecord | null>;
    /** Update the record once the upstream IdP call completed. */
    update(code: string, patch: Partial<AuthCodeRecord>): Promise<void>;
    /** One-shot consumption at the gateway's /token endpoint. */
    consume(code: string): Promise<AuthCodeRecord | null>;
}

export class MemoryAuthCodeStore implements AuthCodeStore {
    private readonly byCode: LRUCache<string, AuthCodeRecord>;
    private readonly upstreamStateToCode = new Map<string, string>();

    constructor(opts: { ttlSeconds?: number } = {}) {
        this.byCode = new LRUCache<string, AuthCodeRecord>({
            max: 10_000,
            ttl: (opts.ttlSeconds ?? 600) * 1000,
            perf: Date,
            dispose: (value: AuthCodeRecord) => {
                this.upstreamStateToCode.delete(value.upstreamState);
            },
        });
    }

    async put(record: AuthCodeRecord): Promise<void> {
        this.byCode.set(record.code, record);
        this.upstreamStateToCode.set(record.upstreamState, record.code);
    }

    async getByUpstreamState(upstreamState: string): Promise<AuthCodeRecord | null> {
        const code = this.upstreamStateToCode.get(upstreamState);
        if (code === undefined) return null;
        return this.byCode.get(code) ?? null;
    }

    async update(code: string, patch: Partial<AuthCodeRecord>): Promise<void> {
        const existing = this.byCode.get(code);
        if (existing === undefined) return;
        this.byCode.set(code, { ...existing, ...patch });
    }

    async consume(code: string): Promise<AuthCodeRecord | null> {
        const record = this.byCode.get(code) ?? null;
        if (record !== null) {
            this.byCode.delete(code);
            this.upstreamStateToCode.delete(record.upstreamState);
        }
        return record;
    }
}

/* ── Gateway-issued access/refresh tokens ────────────────────── */

export interface GatewayTokenRecord {
    accessToken: string;
    refreshToken: string;
    clientId: string;
    subject: string;
    identity: OrchidIdentity;
    /** Seconds since epoch. */
    expiresAt: number;
    scopes: string[];
    /**
     * Upstream IdP tokens carried alongside the gateway-minted pair
     * so the ``/token?grant_type=refresh_token`` handler can swap
     * the upstream refresh for a fresh upstream access token before
     * minting a new gateway pair.  Without these, a gateway refresh
     * produces new gateway tokens still wrapping a stale upstream
     * bearer — orchid-api then rejects the next request with 401
     * and the user has to re-authenticate from scratch.
     *
     * Absence (``undefined`` on any field) means "upstream didn't
     * issue one" (some IdPs simply don't mint refresh tokens for
     * certain grant flavours); the refresh handler falls back to
     * the pre-Phase-4 behaviour of rotating only the gateway pair.
     */
    idpAccessToken?: string;
    idpRefreshToken?: string;
    idpExpiresAt?: number;
}

export interface GatewayTokenStore {
    issue(record: GatewayTokenRecord): Promise<void>;
    getByAccessToken(accessToken: string): Promise<GatewayTokenRecord | null>;
    getByRefreshToken(refreshToken: string): Promise<GatewayTokenRecord | null>;
    revoke(accessToken: string): Promise<void>;
}

export class MemoryGatewayTokenStore implements GatewayTokenStore {
    private readonly byAccess: LRUCache<string, GatewayTokenRecord>;
    private readonly refreshToAccess = new Map<string, string>();

    constructor(opts: { ttlSeconds?: number } = {}) {
        this.byAccess = new LRUCache<string, GatewayTokenRecord>({
            max: 50_000,
            ttl: (opts.ttlSeconds ?? 3600) * 1000,
            perf: Date,
            dispose: (value: GatewayTokenRecord) => {
                this.refreshToAccess.delete(value.refreshToken);
            },
        });
    }

    async issue(record: GatewayTokenRecord): Promise<void> {
        this.byAccess.set(record.accessToken, record);
        this.refreshToAccess.set(record.refreshToken, record.accessToken);
    }

    async getByAccessToken(accessToken: string): Promise<GatewayTokenRecord | null> {
        return this.byAccess.get(accessToken) ?? null;
    }

    async getByRefreshToken(refreshToken: string): Promise<GatewayTokenRecord | null> {
        const access = this.refreshToAccess.get(refreshToken);
        if (access === undefined) return null;
        return this.byAccess.get(access) ?? null;
    }

    async revoke(accessToken: string): Promise<void> {
        const rec = this.byAccess.get(accessToken);
        if (rec === undefined) return;
        this.byAccess.delete(accessToken);
        this.refreshToAccess.delete(rec.refreshToken);
    }
}
