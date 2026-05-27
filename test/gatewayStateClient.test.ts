/**
 * Tests for :class:`HttpGatewayStateClient` + :mod:`httpStores`.
 *
 * msw intercepts every fetch so we assert on the exact HTTP
 * contract (service-token auth, snake_case wire shape, 204/404
 * handling) without spinning up a real orchid-api.
 *
 * Covered slices:
 *   - Auth header — always carries the shared service token.
 *   - ClientStore round-trip via :class:`HttpClientStore`.
 *   - AuthCodeStore + partial-patch via :class:`HttpAuthCodeStore`.
 *   - TokenStore including introspect-by-refresh + 404 on expired.
 *   - Error mapping — 401 / 5xx / timeout / malformed response.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, delay, http } from "msw";
import { setupServer } from "msw/node";

import {
    OrchidResponseShapeError,
    OrchidServerError,
    OrchidTimeoutError,
    OrchidUnauthorizedError,
} from "../src/errors.js";
import { HttpGatewayStateClient, type GatewayStateClient } from "../src/auth/gatewayStateClient.js";
import {
    HttpAuthCodeStore,
    HttpClientStore,
    HttpGatewayTokenStore,
    buildHttpStoreSet,
} from "../src/auth/httpStores.js";
import type { AuthCodeRecord, GatewayTokenRecord, RegisteredClient } from "../src/auth/stores.js";

const BASE = "http://orchid-api.test";
const SERVICE_TOKEN = "shared-sek-123";

const server = setupServer();

beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
    server.resetHandlers();
});
afterAll(() => {
    server.close();
});

let client: HttpGatewayStateClient;

beforeEach(() => {
    client = new HttpGatewayStateClient({
        baseUrl: BASE,
        serviceToken: SERVICE_TOKEN,
        timeoutMs: 2_000,
        fetchImpl: fetch,
    });
});

/* ── Shared fixtures ─────────────────────────────────────── */

function makeClient(): RegisteredClient {
    return {
        client_id: "cli-abc",
        redirect_uris: ["http://localhost:8765/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_name: "MCP Inspector",
        created_at: 1_700_000_000,
    };
}

function makeAuthCode(overrides: Partial<AuthCodeRecord> = {}): AuthCodeRecord {
    return {
        code: "authcode-xyz",
        clientId: "cli-abc",
        redirectUri: "http://localhost:8765/cb",
        codeChallenge: "challenge-abc",
        codeChallengeMethod: "S256",
        upstreamState: "ust-123",
        upstreamCodeVerifier: "verifier-def",
        scopes: ["mcp.read"],
        createdAt: 1_700_000_000,
        ...overrides,
    };
}

function makeToken(overrides: Partial<GatewayTokenRecord> = {}): GatewayTokenRecord {
    return {
        accessToken: "at-1",
        refreshToken: "rt-1",
        clientId: "cli-abc",
        subject: "u-42",
        identity: { bearer: "ups-bearer", subject: "u-42" },
        scopes: ["mcp.read"],
        expiresAt: 1_700_000_000 + 3600,
        ...overrides,
    };
}

/* ── Auth header ─────────────────────────────────────────── */

describe("HttpGatewayStateClient — auth header", () => {
    it("sends Authorization: Bearer <serviceToken> on every request", async () => {
        let seen: Headers | null = null;
        server.use(
            http.get(`${BASE}/mcp-gateway/state/clients/cli-abc`, ({ request }) => {
                seen = request.headers;
                return HttpResponse.json({
                    client_id: "cli-abc",
                    redirect_uris: [],
                    grant_types: [],
                    response_types: [],
                    token_endpoint_auth_method: "none",
                    client_name: "",
                    created_at: 0,
                });
            }),
        );
        await client.getClient("cli-abc");
        const captured = seen as unknown as Headers;
        expect(captured).not.toBeNull();
        expect(captured.get("authorization")).toBe(`Bearer ${SERVICE_TOKEN}`);
    });
});

/* ── ClientStore round-trip ──────────────────────────────── */

describe("HttpClientStore", () => {
    it("register POSTs wire-shaped body and swallows 204", async () => {
        let body: unknown;
        server.use(
            http.post(`${BASE}/mcp-gateway/state/clients`, async ({ request }) => {
                body = await request.json();
                return new HttpResponse(null, { status: 204 });
            }),
        );
        const store = new HttpClientStore(client);
        await store.register(makeClient());
        expect(body).toEqual({
            client_id: "cli-abc",
            redirect_uris: ["http://localhost:8765/cb"],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            client_name: "MCP Inspector",
            created_at: 1_700_000_000,
        });
    });

    it("get parses the wire response into a RegisteredClient", async () => {
        server.use(
            http.get(`${BASE}/mcp-gateway/state/clients/cli-abc`, () =>
                HttpResponse.json({
                    client_id: "cli-abc",
                    redirect_uris: ["http://cb"],
                    grant_types: ["authorization_code"],
                    response_types: ["code"],
                    token_endpoint_auth_method: "none",
                    client_name: "Test",
                    created_at: 42,
                }),
            ),
        );
        const store = new HttpClientStore(client);
        const result = await store.get("cli-abc");
        expect(result).toEqual({
            client_id: "cli-abc",
            redirect_uris: ["http://cb"],
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            client_name: "Test",
            created_at: 42,
        });
    });

    it("get maps 404 to null rather than an error", async () => {
        server.use(
            http.get(`${BASE}/mcp-gateway/state/clients/missing`, () =>
                HttpResponse.json({ detail: "client not found" }, { status: 404 }),
            ),
        );
        const store = new HttpClientStore(client);
        expect(await store.get("missing")).toBeNull();
    });
});

/* ── AuthCodeStore round-trip ────────────────────────────── */

describe("HttpAuthCodeStore", () => {
    it("put POSTs wire-shaped body with snake_case fields", async () => {
        let body: Record<string, unknown> | null = null;
        server.use(
            http.post(`${BASE}/mcp-gateway/state/auth-codes`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        const store = new HttpAuthCodeStore(client);
        await store.put(makeAuthCode({ clientState: "echo-state" }));
        expect(body).toMatchObject({
            code: "authcode-xyz",
            client_id: "cli-abc",
            redirect_uri: "http://localhost:8765/cb",
            code_challenge: "challenge-abc",
            code_challenge_method: "S256",
            upstream_state: "ust-123",
            upstream_code_verifier: "verifier-def",
            scopes: ["mcp.read"],
            client_state: "echo-state",
            // Defaults for unset post-exchange fields.
            identity: null,
            idp_access_token: "",
            idp_refresh_token: "",
            idp_expires_at: 0,
            created_at: 1_700_000_000,
        });
    });

    it("getByUpstreamState parses the response into camelCase", async () => {
        server.use(
            http.post(
                `${BASE}/mcp-gateway/state/auth-codes/lookup-by-upstream-state`,
                async ({ request }) => {
                    const body = (await request.json()) as { upstream_state: string };
                    expect(body.upstream_state).toBe("ust-123");
                    return HttpResponse.json({
                        code: "authcode-xyz",
                        client_id: "cli-abc",
                        redirect_uri: "http://cb",
                        code_challenge: "c",
                        code_challenge_method: "S256",
                        upstream_state: "ust-123",
                        upstream_code_verifier: "v",
                        scopes: ["mcp.read"],
                        client_state: "echo",
                        identity: { bearer: "b", subject: "u-1" },
                        idp_access_token: "at",
                        idp_refresh_token: "rt",
                        idp_expires_at: 999,
                        created_at: 1,
                    });
                },
            ),
        );
        const store = new HttpAuthCodeStore(client);
        const result = await store.getByUpstreamState("ust-123");
        expect(result).not.toBeNull();
        expect(result?.code).toBe("authcode-xyz");
        expect(result?.clientId).toBe("cli-abc");
        expect(result?.redirectUri).toBe("http://cb");
        expect(result?.clientState).toBe("echo");
        expect(result?.identity).toEqual({ bearer: "b", subject: "u-1" });
        expect(result?.idpAccessToken).toBe("at");
        expect(result?.idpRefreshToken).toBe("rt");
        expect(result?.idpExpiresAt).toBe(999);
    });

    it("getByUpstreamState returns null on 404", async () => {
        server.use(
            http.post(`${BASE}/mcp-gateway/state/auth-codes/lookup-by-upstream-state`, () =>
                HttpResponse.json({ detail: "auth code not found" }, { status: 404 }),
            ),
        );
        const store = new HttpAuthCodeStore(client);
        expect(await store.getByUpstreamState("unknown")).toBeNull();
    });

    it("update sends only specified fields (partial patch)", async () => {
        let body: Record<string, unknown> | null = null;
        server.use(
            http.patch(`${BASE}/mcp-gateway/state/auth-codes/authcode-xyz`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        const store = new HttpAuthCodeStore(client);
        await store.update("authcode-xyz", {
            idpAccessToken: "at-v1",
            idpRefreshToken: "rt-v1",
            idpExpiresAt: 12_345,
        });
        // identity deliberately omitted — must NOT appear on the wire.
        expect(body).toEqual({
            idp_access_token: "at-v1",
            idp_refresh_token: "rt-v1",
            idp_expires_at: 12_345,
        });
    });

    it("update with no fields sends an empty object (server-side no-op)", async () => {
        let body: Record<string, unknown> | null = null;
        server.use(
            http.patch(`${BASE}/mcp-gateway/state/auth-codes/authcode-xyz`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        const store = new HttpAuthCodeStore(client);
        await store.update("authcode-xyz", {});
        expect(body).toEqual({});
    });

    it("consume returns the record then the next call returns null", async () => {
        let calls = 0;
        server.use(
            http.post(`${BASE}/mcp-gateway/state/auth-codes/authcode-xyz/consume`, () => {
                calls += 1;
                if (calls === 1) {
                    return HttpResponse.json({
                        code: "authcode-xyz",
                        client_id: "cli-abc",
                        redirect_uri: "http://cb",
                        code_challenge: "c",
                        code_challenge_method: "S256",
                        upstream_state: "ust-123",
                        upstream_code_verifier: "v",
                        scopes: ["mcp.read"],
                        client_state: "",
                        identity: null,
                        idp_access_token: "",
                        idp_refresh_token: "",
                        idp_expires_at: 0,
                        created_at: 1,
                    });
                }
                return HttpResponse.json({ detail: "auth code not found" }, { status: 404 });
            }),
        );
        const store = new HttpAuthCodeStore(client);
        const first = await store.consume("authcode-xyz");
        expect(first).not.toBeNull();
        expect(first?.code).toBe("authcode-xyz");

        const second = await store.consume("authcode-xyz");
        expect(second).toBeNull();
    });
});

/* ── GatewayTokenStore round-trip ────────────────────────── */

describe("HttpGatewayTokenStore", () => {
    it("issue POSTs wire-shaped body", async () => {
        let body: Record<string, unknown> | null = null;
        server.use(
            http.post(`${BASE}/mcp-gateway/state/tokens`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        const store = new HttpGatewayTokenStore(client);
        await store.issue(makeToken());
        expect(body).toEqual({
            access_token: "at-1",
            refresh_token: "rt-1",
            client_id: "cli-abc",
            subject: "u-42",
            identity: { bearer: "ups-bearer", subject: "u-42" },
            scopes: ["mcp.read"],
            expires_at: 1_700_000_000 + 3600,
            // Upstream-token fields — defaults when the caller
            // doesn't set the optional idpAccessToken /
            // idpRefreshToken / idpExpiresAt properties on the
            // record.
            idp_access_token: "",
            idp_refresh_token: "",
            idp_expires_at: 0,
        });
    });

    it("round-trips idp_* fields when the caller sets them", async () => {
        let body: Record<string, unknown> | null = null;
        server.use(
            http.post(`${BASE}/mcp-gateway/state/tokens`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        const store = new HttpGatewayTokenStore(client);
        await store.issue(
            makeToken({
                idpAccessToken: "idp-at-1",
                idpRefreshToken: "idp-rt-1",
                idpExpiresAt: 999_999,
            }),
        );
        expect(body).toMatchObject({
            idp_access_token: "idp-at-1",
            idp_refresh_token: "idp-rt-1",
            idp_expires_at: 999_999,
        });
    });

    it("getByAccessToken sends access_token in introspect body and parses response", async () => {
        let body: Record<string, unknown> | null = null;
        server.use(
            http.post(`${BASE}/mcp-gateway/state/tokens/introspect`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({
                    access_token: "at-1",
                    refresh_token: "rt-1",
                    client_id: "cli-abc",
                    subject: "u-42",
                    identity: { bearer: "b", subject: "u-42" },
                    scopes: ["mcp.read"],
                    expires_at: 9999,
                });
            }),
        );
        const store = new HttpGatewayTokenStore(client);
        const result = await store.getByAccessToken("at-1");
        expect(body).toEqual({ access_token: "at-1" });
        expect(result).not.toBeNull();
        expect(result?.subject).toBe("u-42");
        expect(result?.identity).toEqual({ bearer: "b", subject: "u-42" });
    });

    it("getByRefreshToken sends refresh_token instead", async () => {
        let body: Record<string, unknown> | null = null;
        server.use(
            http.post(`${BASE}/mcp-gateway/state/tokens/introspect`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({
                    access_token: "at-1",
                    refresh_token: "rt-1",
                    client_id: "cli-abc",
                    subject: "u-42",
                    identity: { bearer: "b", subject: "u-42" },
                    scopes: ["mcp.read"],
                    expires_at: 9999,
                });
            }),
        );
        const store = new HttpGatewayTokenStore(client);
        const result = await store.getByRefreshToken("rt-1");
        expect(body).toEqual({ refresh_token: "rt-1" });
        expect(result?.accessToken).toBe("at-1");
    });

    it("lookups return null on 404", async () => {
        server.use(
            http.post(`${BASE}/mcp-gateway/state/tokens/introspect`, () =>
                HttpResponse.json({ detail: "token not found" }, { status: 404 }),
            ),
        );
        const store = new HttpGatewayTokenStore(client);
        expect(await store.getByAccessToken("missing")).toBeNull();
        expect(await store.getByRefreshToken("missing")).toBeNull();
    });

    it("revoke DELETEs the encoded token", async () => {
        let seenUrl: string | null = null;
        server.use(
            http.delete(`${BASE}/mcp-gateway/state/tokens/:token`, ({ request }) => {
                seenUrl = request.url;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        const store = new HttpGatewayTokenStore(client);
        await store.revoke("at with/slash");
        expect(seenUrl).not.toBeNull();
        // URL-encoded: the slash and space become %2F and %20.
        expect(seenUrl).toContain("/tokens/at%20with%2Fslash");
    });
});

/* ── buildHttpStoreSet ───────────────────────────────────── */

describe("buildHttpStoreSet", () => {
    it("returns three stores that share a single client", async () => {
        let clientRequests = 0;
        const fakeClient: GatewayStateClient = {
            registerClient: async () => {
                clientRequests += 1;
            },
            getClient: async () => null,
            putAuthCode: async () => {
                clientRequests += 1;
            },
            getAuthCodeByUpstreamState: async () => null,
            updateAuthCode: async () => {
                /* no-op — counted via issueToken */
            },
            consumeAuthCode: async () => null,
            issueToken: async () => {
                clientRequests += 1;
            },
            getTokenByAccessToken: async () => null,
            getTokenByRefreshToken: async () => null,
            revokeToken: async () => {
                /* no-op — counted via issueToken */
            },
        };
        const { clientStore, authCodeStore, tokenStore } = buildHttpStoreSet(fakeClient);

        await clientStore.register(makeClient());
        await authCodeStore.put(makeAuthCode());
        await tokenStore.issue(makeToken());
        expect(clientRequests).toBe(3);
    });
});

/* ── Error mapping ───────────────────────────────────────── */

describe("HttpGatewayStateClient — error mapping", () => {
    it("401 surfaces as OrchidUnauthorizedError with service-token hint", async () => {
        server.use(
            http.post(`${BASE}/mcp-gateway/state/clients`, () =>
                HttpResponse.json({ detail: "Invalid service token" }, { status: 401 }),
            ),
        );
        const store = new HttpClientStore(client);
        await expect(store.register(makeClient())).rejects.toThrow(OrchidUnauthorizedError);
    });

    it("503 (disabled endpoint group) surfaces as OrchidServerError", async () => {
        server.use(
            http.post(`${BASE}/mcp-gateway/state/clients`, () =>
                HttpResponse.json(
                    { detail: "MCP-gateway-state endpoints are disabled." },
                    { status: 503 },
                ),
            ),
        );
        const store = new HttpClientStore(client);
        await expect(store.register(makeClient())).rejects.toThrow(OrchidServerError);
    });

    it("body shape mismatch surfaces as OrchidResponseShapeError", async () => {
        server.use(
            http.get(`${BASE}/mcp-gateway/state/clients/cli-abc`, () =>
                HttpResponse.json({ not: "a client" }),
            ),
        );
        const store = new HttpClientStore(client);
        await expect(store.get("cli-abc")).rejects.toThrow(OrchidResponseShapeError);
    });

    it("slow upstream surfaces as OrchidTimeoutError", async () => {
        server.use(
            http.get(`${BASE}/mcp-gateway/state/clients/cli-abc`, async () => {
                await delay(4_000);
                return HttpResponse.json({});
            }),
        );
        const fastClient = new HttpGatewayStateClient({
            baseUrl: BASE,
            serviceToken: SERVICE_TOKEN,
            timeoutMs: 50,
            fetchImpl: fetch,
        });
        const store = new HttpClientStore(fastClient);
        await expect(store.get("cli-abc")).rejects.toThrow(OrchidTimeoutError);
    });
});
