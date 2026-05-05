import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MCPRequestContext, OrchidIdentity } from "../src/auth/base.js";
import {
    MCPOAuthStrategy,
    type IdPTokens,
    type MCPOAuthStrategyOptions,
} from "../src/auth/oauth.js";
import {
    MemoryAuthCodeStore,
    MemoryClientStore,
    MemoryGatewayTokenStore,
    type GatewayTokenRecord,
    type RegisteredClient,
} from "../src/auth/stores.js";
import { OrchidUnauthorizedError } from "../src/errors.js";
import { createLogger } from "../src/observability/logger.js";
import { FakeIdP } from "./_helpers/fakeIdP.js";

let fakeIdP: FakeIdP;
let idpMeta: Awaited<ReturnType<FakeIdP["start"]>>;
let strategy: MCPOAuthStrategy;
let server: Server;
let baseUrl: string;

async function startGatewayOAuthServer(
    buildOpts: (idp: typeof idpMeta) => MCPOAuthStrategyOptions,
): Promise<void> {
    // Grab a free port on 127.0.0.1, then tear down the probe and listen on it.
    // This lets us build the strategy with the correct ``gatewayBaseUrl``
    // before the server starts — the metadata documents reference
    // ``gatewayBaseUrl``, so it must be known at construction time.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    baseUrl = `http://127.0.0.1:${String(port)}`;

    strategy = new MCPOAuthStrategy({ ...buildOpts(idpMeta), gatewayBaseUrl: baseUrl });
    const routes = strategy.httpRoutes();
    server = createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url ?? "/", "http://placeholder");
            for (const r of routes) {
                if (r.path === url.pathname && r.method === req.method) {
                    await r.handle(req, res);
                    return;
                }
            }
            res.writeHead(404).end();
        })();
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}

beforeAll(async () => {
    fakeIdP = new FakeIdP({ user: { sub: "user-42", email: "alice@example.com" } });
    idpMeta = await fakeIdP.start();
});

afterAll(async () => {
    await fakeIdP.stop();
});

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function baseOptions(): MCPOAuthStrategyOptions {
    // NOTE: gatewayBaseUrl is overwritten after listen so it matches the
    // actual port; tests that need metadata exact-URL matches will re-build
    // the strategy with the real baseUrl.
    return {
        logger: createLogger("silent"),
        gatewayBaseUrl: "http://127.0.0.1:1",
        tokenTtlS: 3600,
        clientRegistrationEnabled: true,
        idp: {
            issuer: idpMeta.issuer,
            authorizationEndpoint: idpMeta.authorizationEndpoint,
            clientId: "gw-test-client",
            scopes: "openid profile email",
        },
        clientStore: new MemoryClientStore(),
        authCodeStore: new MemoryAuthCodeStore(),
        tokenStore: new MemoryGatewayTokenStore(),
        // Both delegates are required.  The defaults below
        // hit the :class:`FakeIdP` directly so tests that don't care
        // about the delegate plumbing exercise the full flow without
        // each having to wire its own fakes.  Tests that explicitly
        // care (the dedicated delegation describes) override these
        // via ``startGatewayOAuthServer`` overrides.
        exchangeUpstreamCode: defaultExchangeViaFakeIdP,
        resolveIdentity: defaultResolveViaFakeIdP,
    };
}

/**
 * Default ``exchangeUpstreamCode`` that hits the FakeIdP's token
 * endpoint directly.  Stands in for orchid-api's
 * ``/auth/exchange-code`` (which would do the same thing on the
 * server side).  Lives here so tests don't have to mock the
 * delegate themselves unless they're specifically testing
 * delegate behaviour.
 */
async function defaultExchangeViaFakeIdP(params: {
    code: string;
    redirect_uri: string;
    code_verifier: string;
}): Promise<IdPTokens> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", params.code);
    body.set("redirect_uri", params.redirect_uri);
    body.set("client_id", "gw-test-client");
    body.set("code_verifier", params.code_verifier);
    const response = await fetch(idpMeta.tokenEndpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: body.toString(),
    });
    if (!response.ok) {
        throw new Error(`FakeIdP token exchange failed: ${String(response.status)}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const out: IdPTokens = { access_token: String(json.access_token ?? "") };
    if (typeof json.refresh_token === "string") out.refresh_token = json.refresh_token;
    if (typeof json.token_type === "string") out.token_type = json.token_type;
    if (typeof json.expires_in === "number") {
        out.expires_at = Math.floor(Date.now() / 1000) + json.expires_in;
    }
    return out;
}

/**
 * Default ``resolveIdentity`` that hits the FakeIdP's userinfo
 * endpoint and returns an :type:`OrchidIdentity` with the access
 * token as the bearer (matching the pre-Phase-5 ``passthrough``
 * default).  Mirrors what orchid-api's ``/auth/resolve-identity``
 * would do for an OIDC-shaped upstream — the test FakeIdP returns
 * standard ``sub`` / ``email`` claims.
 */
async function defaultResolveViaFakeIdP(accessToken: string): Promise<OrchidIdentity> {
    const response = await fetch(idpMeta.userinfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
        throw new Error(`FakeIdP userinfo failed: ${String(response.status)}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const sub = String(json.sub ?? "");
    const identity: OrchidIdentity = { bearer: accessToken, subject: sub };
    if (typeof json.email === "string") {
        const at = json.email.lastIndexOf("@");
        if (at >= 0 && at < json.email.length - 1) {
            identity.authDomain = json.email.slice(at + 1);
        }
    }
    return identity;
}

async function startWithRealBase(): Promise<void> {
    await startGatewayOAuthServer(() => baseOptions());
}

/* ── Metadata documents ─────────────────────────────────────── */

describe("OAuth metadata", () => {
    it("serves RFC 8414 authorization-server metadata", async () => {
        await startWithRealBase();
        const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
        expect(res.status).toBe(200);
        const meta = (await res.json()) as Record<string, unknown>;
        expect(meta.issuer).toBe(baseUrl);
        expect(meta.authorization_endpoint).toBe(`${baseUrl}/authorize`);
        expect(meta.token_endpoint).toBe(`${baseUrl}/token`);
        expect(meta.registration_endpoint).toBe(`${baseUrl}/register`);
        expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
        expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
    });

    it("serves RFC 9728 protected-resource metadata", async () => {
        await startWithRealBase();
        const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
        expect(res.status).toBe(200);
        const meta = (await res.json()) as Record<string, unknown>;
        expect(meta.resource).toBe(baseUrl);
        expect(meta.authorization_servers).toEqual([baseUrl]);
    });

    it("omits registration_endpoint when DCR is disabled", async () => {
        await startGatewayOAuthServer(() => ({ ...baseOptions(), clientRegistrationEnabled: false }));
        const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
        const meta = (await res.json()) as Record<string, unknown>;
        expect(meta.registration_endpoint).toBeUndefined();
    });
});

/* ── DCR (RFC 7591) ─────────────────────────────────────────── */

describe("Dynamic Client Registration", () => {
    it("issues a client_id and returns the full registration object", async () => {
        await startWithRealBase();
        const res = await fetch(`${baseUrl}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                redirect_uris: ["http://localhost:7000/callback"],
                client_name: "My MCP client",
            }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as RegisteredClient;
        expect(body.client_id).toMatch(/^mcp-/);
        expect(body.redirect_uris).toEqual(["http://localhost:7000/callback"]);
        expect(body.token_endpoint_auth_method).toBe("none");
    });

    it("rejects a registration without redirect_uris", async () => {
        await startWithRealBase();
        const res = await fetch(`${baseUrl}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it("returns 404 when DCR is disabled", async () => {
        await startGatewayOAuthServer(() => ({ ...baseOptions(), clientRegistrationEnabled: false }));
        const res = await fetch(`${baseUrl}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(404);
    });
});

/* ── /authorize validation ──────────────────────────────────── */

describe("/authorize validation", () => {
    it("rejects a missing code_challenge", async () => {
        await startWithRealBase();
        const client = await registerClient();
        const res = await fetch(
            `${baseUrl}/authorize?${params({
                client_id: client.client_id,
                redirect_uri: client.redirect_uris[0] ?? "",
                response_type: "code",
            })}`,
            { redirect: "manual" },
        );
        expect(res.status).toBe(400);
    });

    it("rejects a non-S256 code_challenge_method", async () => {
        await startWithRealBase();
        const client = await registerClient();
        const res = await fetch(
            `${baseUrl}/authorize?${params({
                client_id: client.client_id,
                redirect_uri: client.redirect_uris[0] ?? "",
                response_type: "code",
                code_challenge: "x",
                code_challenge_method: "plain",
            })}`,
            { redirect: "manual" },
        );
        expect(res.status).toBe(400);
    });

    it("rejects an unknown client_id", async () => {
        await startWithRealBase();
        const res = await fetch(
            `${baseUrl}/authorize?${params({
                client_id: "does-not-exist",
                redirect_uri: "http://x",
                response_type: "code",
                code_challenge: "x",
            })}`,
            { redirect: "manual" },
        );
        expect(res.status).toBe(400);
    });
});

/* ── Full auth flow end-to-end ──────────────────────────────── */

describe("full OAuth flow", () => {
    it("completes register → authorize → callback → token → resolve()", async () => {
        await startWithRealBase();
        const client = await registerClient();
        const verifier = randomBase64Url(64);
        const challenge = sha256Base64Url(verifier);
        const state = "client-state-xyz";

        // 1. /authorize → redirect to IdP
        const authRes = await fetch(
            `${baseUrl}/authorize?${params({
                client_id: client.client_id,
                redirect_uri: client.redirect_uris[0] ?? "",
                response_type: "code",
                code_challenge: challenge,
                code_challenge_method: "S256",
                state,
                scope: "openid profile email",
            })}`,
            { redirect: "manual" },
        );
        expect(authRes.status).toBe(302);
        const idpUrl = authRes.headers.get("location") ?? "";
        expect(idpUrl.startsWith(idpMeta.authorizationEndpoint)).toBe(true);

        // 2. Fake IdP handles it, redirects to our /oauth/callback
        const idpRes = await fetch(idpUrl, { redirect: "manual" });
        expect(idpRes.status).toBe(302);
        const callbackUrl = idpRes.headers.get("location") ?? "";
        expect(callbackUrl.startsWith(`${baseUrl}/oauth/callback`)).toBe(true);

        // 3. /oauth/callback → redirect to client's redirect_uri with code + state
        const cbRes = await fetch(callbackUrl, { redirect: "manual" });
        expect(cbRes.status).toBe(302);
        const finalUrl = new URL(cbRes.headers.get("location") ?? "");
        expect(finalUrl.href.startsWith(client.redirect_uris[0] ?? "")).toBe(true);
        expect(finalUrl.searchParams.get("state")).toBe(state);
        const gatewayCode = finalUrl.searchParams.get("code");
        expect(gatewayCode).toMatch(/^gw-/);

        // 4. /token — exchange gateway code for tokens
        const tokenRes = await fetch(`${baseUrl}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params({
                grant_type: "authorization_code",
                code: gatewayCode ?? "",
                code_verifier: verifier,
                client_id: client.client_id,
                redirect_uri: client.redirect_uris[0] ?? "",
            }),
        });
        expect(tokenRes.status).toBe(200);
        const tokens = (await tokenRes.json()) as Record<string, unknown>;
        expect(typeof tokens.access_token).toBe("string");
        expect(typeof tokens.refresh_token).toBe("string");
        expect(tokens.token_type).toBe("Bearer");

        // 5. MCPOAuthStrategy.resolve() returns the OrchidIdentity for this token.
        const ctx: MCPRequestContext = {
            mcpSessionId: "sess-x",
            headers: {},
            accessToken: tokens.access_token as string,
        };
        const identity = await strategy.resolve(ctx);
        expect(identity.subject).toBe("user-42");
        expect(identity.authDomain).toBe("example.com");
        expect(identity.bearer).toMatch(/^idp-at-/); // passthroughResolver forwards the IdP token
    });

    it("rejects /token with a mismatched PKCE verifier", async () => {
        await startWithRealBase();
        const { gatewayCode, client } = await runUntilGatewayCode();
        const res = await fetch(`${baseUrl}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params({
                grant_type: "authorization_code",
                code: gatewayCode,
                code_verifier: "wrong-verifier",
                client_id: client.client_id,
                redirect_uri: client.redirect_uris[0] ?? "",
            }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("invalid_grant");
    });

    it("one-shot auth codes — replay is rejected", async () => {
        await startWithRealBase();
        const { gatewayCode, client, verifier } = await runUntilGatewayCode();
        const first = await exchangeCode(client, gatewayCode, verifier);
        expect(first.status).toBe(200);
        const second = await exchangeCode(client, gatewayCode, verifier);
        expect(second.status).toBe(400);
    });

    it("refresh_token rotates the access token", async () => {
        await startWithRealBase();
        const { gatewayCode, client, verifier } = await runUntilGatewayCode();
        const tokRes = await exchangeCode(client, gatewayCode, verifier);
        const tok = (await tokRes.json()) as Record<string, string>;

        const refreshRes = await fetch(`${baseUrl}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params({
                grant_type: "refresh_token",
                refresh_token: tok.refresh_token ?? "",
                client_id: client.client_id,
            }),
        });
        expect(refreshRes.status).toBe(200);
        const fresh = (await refreshRes.json()) as Record<string, string>;
        expect(fresh.access_token).not.toBe(tok.access_token);

        // Old access token now rejected.
        await expect(
            strategy.resolve({
                mcpSessionId: "s",
                headers: {},
                accessToken: tok.access_token ?? "",
            }),
        ).rejects.toBeInstanceOf(OrchidUnauthorizedError);
        // New access token accepted.
        const identity = await strategy.resolve({
            mcpSessionId: "s",
            headers: {},
            accessToken: fresh.access_token ?? "",
        });
        expect(identity.subject).toBe("user-42");
    });
});

/* ── strategy.resolve() behaviour ───────────────────────────── */

describe("MCPOAuthStrategy.resolve", () => {
    beforeEach(async () => {
        await startWithRealBase();
    });

    it("throws OrchidUnauthorizedError on a missing token", async () => {
        await expect(
            strategy.resolve({ mcpSessionId: "s", headers: {} }),
        ).rejects.toBeInstanceOf(OrchidUnauthorizedError);
    });

    it("throws OrchidUnauthorizedError on an unknown token", async () => {
        await expect(
            strategy.resolve({ mcpSessionId: "s", headers: {}, accessToken: "never-issued" }),
        ).rejects.toBeInstanceOf(OrchidUnauthorizedError);
    });
});

/* ── Helpers ────────────────────────────────────────────────── */

/* ── Platform authDomain override ──────────────────────────── */

describe("platform authDomain override", () => {
    it("overrides identity.authDomain with the configured platform domain", async () => {
        // The fake IdP issues a ``@example.com`` email so the email-
        // domain heuristic would derive ``authDomain=example.com``
        // — but for a multi-tenant deployment the platform domain is
        // a deploy-time constant unrelated to the user's email.
        // Setting ``idp.authDomain`` forces the right value.
        await startGatewayOAuthServer(() => ({
            ...baseOptions(),
            idp: {
                ...baseOptions().idp,
                authDomain: "mytenant.example.com",
            },
        }));

        const { client, gatewayCode, verifier } = await runUntilGatewayCode();
        const tokRes = await exchangeCode(client, gatewayCode, verifier);
        expect(tokRes.status).toBe(200);
        const tok = (await tokRes.json()) as Record<string, string>;

        const identity = await strategy.resolve({
            mcpSessionId: "s",
            headers: {},
            accessToken: tok.access_token ?? "",
        });
        expect(identity.authDomain).toBe("mytenant.example.com");
    });

    it("leaves identity.authDomain alone when no platform domain is configured", async () => {
        await startWithRealBase();
        const { client, gatewayCode, verifier } = await runUntilGatewayCode();
        const tokRes = await exchangeCode(client, gatewayCode, verifier);
        const tok = (await tokRes.json()) as Record<string, string>;

        const identity = await strategy.resolve({
            mcpSessionId: "s",
            headers: {},
            accessToken: tok.access_token ?? "",
        });
        // passthroughResolver derived ``example.com`` from the email.
        expect(identity.authDomain).toBe("example.com");
    });
});

/* ── exchangeUpstreamCode delegation ────────────── */

describe("upstream-code exchange delegation", () => {
    it("uses the injected delegate instead of calling tokenEndpoint directly", async () => {
        // Build a delegate that mints fake tokens without reaching the
        // FakeIdP's token endpoint.  If handleCallback delegates as
        // intended, the FakeIdP never sees the POST.
        const delegateCalls: unknown[] = [];
        const delegate = async (params: {
            code: string;
            redirect_uri: string;
            code_verifier: string;
        }): Promise<{
            access_token: string;
            refresh_token?: string;
            token_type?: string;
            expires_at?: number;
        }> => {
            delegateCalls.push(params);
            return {
                access_token: "at-from-delegate",
                refresh_token: "rt-from-delegate",
                token_type: "Bearer",
                expires_at: Math.floor(Date.now() / 1000) + 3600,
            };
        };

        await startGatewayOAuthServer(() => ({
            ...baseOptions(),
            exchangeUpstreamCode: delegate,
            // Scrub the client secret — modern deployments don't
            // carry it on the gateway side.  The strategy must still
            // complete OAuth without it.
            idp: {
                ...baseOptions().idp,
                clientSecret: undefined as unknown as string,
            },
        }));

        const { client, gatewayCode, verifier } = await runUntilGatewayCode();
        const tokRes = await exchangeCode(client, gatewayCode, verifier);
        expect(tokRes.status).toBe(200);
        const tok = (await tokRes.json()) as Record<string, string>;

        // Gateway minted its own access_token from the delegate's output.
        const identity = await strategy.resolve({
            mcpSessionId: "s",
            headers: {},
            accessToken: tok.access_token ?? "",
        });
        expect(identity.subject).toBe("user-42");
        // Delegate was called exactly once with the expected params.
        expect(delegateCalls.length).toBe(1);
        const call = delegateCalls[0] as {
            code: string;
            redirect_uri: string;
            code_verifier: string;
        };
        expect(call.code).toMatch(/^idp-code-/); // Upstream code from FakeIdP
        expect(call.redirect_uri).toBe(`${baseUrl}/oauth/callback`);
        expect(typeof call.code_verifier).toBe("string");
        expect(call.code_verifier.length).toBeGreaterThan(0);
    });

    it("surfaces delegate errors as 502 on the callback", async () => {
        // A failing delegate must not silently succeed — the user
        // needs to see a clean error so they re-try the flow.
        const delegate = async (): Promise<{ access_token: string }> => {
            throw new Error("orchid-api is unreachable");
        };

        await startGatewayOAuthServer(() => ({
            ...baseOptions(),
            exchangeUpstreamCode: delegate,
        }));

        const client = await registerClient();
        const verifier = randomBase64Url(64);
        const challenge = sha256Base64Url(verifier);

        const authRes = await fetch(
            `${baseUrl}/authorize?${params({
                client_id: client.client_id,
                redirect_uri: client.redirect_uris[0] ?? "",
                response_type: "code",
                code_challenge: challenge,
                code_challenge_method: "S256",
            })}`,
            { redirect: "manual" },
        );
        const idpUrl = authRes.headers.get("location") ?? "";
        const idpRes = await fetch(idpUrl, { redirect: "manual" });
        const callbackUrl = idpRes.headers.get("location") ?? "";
        const cbRes = await fetch(callbackUrl, { redirect: "manual" });

        expect(cbRes.status).toBe(502);
        const body = (await cbRes.json()) as { error: string };
        expect(body.error).toBe("upstream_token_exchange_failed");
    });
});

/* ── Identity-resolution delegation ───────────────── */

describe("identity-resolver delegation", () => {
    it("uses the injected delegate instead of fetchUserinfo + scripted resolver", async () => {
        // The strategy's default path hits the FakeIdP's userinfo.
        // When ``resolveIdentity`` is wired, both userinfo AND the
        // local :type:`IdentityResolver` are bypassed — if the
        // delegate handles everything, the fake's userinfo endpoint
        // is never hit AND the local resolver never runs.  We prove
        // both by (a) counting delegate invocations and (b) wiring a
        // throwing ``identityResolver`` that would fail the test if
        // it were ever reached.
        const delegateCalls: string[] = [];
        const throwingResolver = {
            resolve: async () => {
                throw new Error("local resolver must NOT be invoked");
            },
        };

        await startGatewayOAuthServer(() => ({
            ...baseOptions(),
            identityResolver: throwingResolver,
            resolveIdentity: async (accessToken) => {
                delegateCalls.push(accessToken);
                return {
                    bearer: "tok-from-api",
                    subject: "delegated-subject",
                    authDomain: "delegated.example.com",
                };
            },
        }));

        const { client, gatewayCode, verifier } = await runUntilGatewayCode();
        const tokRes = await exchangeCode(client, gatewayCode, verifier);
        expect(tokRes.status).toBe(200);
        const tok = (await tokRes.json()) as Record<string, string>;

        const identity = await strategy.resolve({
            mcpSessionId: "s",
            headers: {},
            accessToken: tok.access_token ?? "",
        });
        expect(identity.subject).toBe("delegated-subject");
        expect(identity.bearer).toBe("tok-from-api");
        expect(identity.authDomain).toBe("delegated.example.com");
        // Delegate was called with the upstream access token from
        // the exchange step.  FakeIdP tokens are opaque strings; we
        // just confirm we got one.
        expect(delegateCalls.length).toBe(1);
        expect(delegateCalls[0]?.length ?? 0).toBeGreaterThan(0);
    });

    it("surfaces delegate errors as 502 on the callback", async () => {
        // A failing delegate (e.g. orchid-api's
        // ``/auth/resolve-identity`` 503ing mid-login) must surface
        // as a clean 502 on the callback so the user can re-try
        // rather than getting a silent-success with a corrupted
        // identity record.
        await startGatewayOAuthServer(() => ({
            ...baseOptions(),
            resolveIdentity: async () => {
                throw new Error("orchid-api identity endpoint unreachable");
            },
        }));

        const client = await registerClient();
        const verifier = randomBase64Url(64);
        const challenge = sha256Base64Url(verifier);
        const authRes = await fetch(
            `${baseUrl}/authorize?${params({
                client_id: client.client_id,
                redirect_uri: client.redirect_uris[0] ?? "",
                response_type: "code",
                code_challenge: challenge,
                code_challenge_method: "S256",
            })}`,
            { redirect: "manual" },
        );
        const idpUrl = authRes.headers.get("location") ?? "";
        const idpRes = await fetch(idpUrl, { redirect: "manual" });
        const callbackUrl = idpRes.headers.get("location") ?? "";
        const cbRes = await fetch(callbackUrl, { redirect: "manual" });

        expect(cbRes.status).toBe(502);
        const body = (await cbRes.json()) as { error: string };
        expect(body.error).toBe("identity_resolver_failed");
    });
});

/* ── Upstream-refresh delegation ──────────────────── */

describe("upstream-refresh delegation", () => {
    it("swaps upstream tokens on gateway refresh when delegate + idpRefreshToken are present", async () => {
        // Seed a gateway token record with an upstream refresh
        // token — mimics what ``tokenAuthorizationCode`` produces.
        // Then drive a
        // ``grant_type=refresh_token`` against the gateway and
        // assert the delegate was called with the stored idp
        // refresh token and the new gateway record carries the
        // refreshed upstream bearer.
        const delegateCalls: string[] = [];
        const delegate = async (refreshToken: string) => {
            delegateCalls.push(refreshToken);
            return {
                access_token: "fresh-upstream-at",
                refresh_token: "fresh-upstream-rt",
                expires_at: Math.floor(Date.now() / 1000) + 3600,
            };
        };

        await startGatewayOAuthServer(() => ({
            ...baseOptions(),
            refreshUpstreamToken: delegate,
        }));

        // Seed token store with a pre-baked record (skip the full
        // OAuth dance — we're testing refresh in isolation).
        const opts = baseOptions(); // ignore — we just need the store reference
        const seeded: GatewayTokenRecord = {
            accessToken: "gw-at-seed",
            refreshToken: "gw-rt-seed",
            clientId: "seed-client",
            subject: "user-42",
            identity: { bearer: "stale-upstream-at", subject: "user-42" },
            expiresAt: Math.floor(Date.now() / 1000) + 100,
            scopes: ["api"],
            idpAccessToken: "stale-upstream-at",
            idpRefreshToken: "stale-upstream-rt",
            idpExpiresAt: Math.floor(Date.now() / 1000) - 10,
        };
        void opts;
        await (
            // The strategy owns the store via ``opts`` — access it
            // through the mounted strategy to keep the test reading
            // the SAME store the routes use.
            strategy as unknown as {
                opts: { tokenStore: { issue: (r: GatewayTokenRecord) => Promise<void> } };
            }
        ).opts.tokenStore.issue(seeded);

        const form = new URLSearchParams();
        form.set("grant_type", "refresh_token");
        form.set("refresh_token", "gw-rt-seed");
        form.set("client_id", "seed-client");
        const res = await fetch(`${baseUrl}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
        });
        expect(res.status).toBe(200);
        const tok = (await res.json()) as Record<string, string>;

        // Delegate received the stored idp refresh token.
        expect(delegateCalls).toEqual(["stale-upstream-rt"]);

        // New gateway token carries the refreshed upstream bearer.
        const identity = await strategy.resolve({
            mcpSessionId: "s",
            headers: {},
            accessToken: tok.access_token ?? "",
        });
        expect(identity.bearer).toBe("fresh-upstream-at");
    });

    it("surfaces delegate errors as invalid_grant to force re-authentication", async () => {
        // A failing upstream refresh (e.g. user logged out at the
        // IdP) must trigger a clean ``invalid_grant`` — the MCP
        // client then runs the full re-auth dance.  Rotating gateway
        // tokens silently would wrap a dead upstream bearer and
        // produce cascading 401s on backend calls.
        await startGatewayOAuthServer(() => ({
            ...baseOptions(),
            refreshUpstreamToken: async () => {
                throw new Error("upstream revoked the refresh grant");
            },
        }));

        const seeded: GatewayTokenRecord = {
            accessToken: "gw-at-dead",
            refreshToken: "gw-rt-dead",
            clientId: "seed-client",
            subject: "user-42",
            identity: { bearer: "stale", subject: "user-42" },
            expiresAt: Math.floor(Date.now() / 1000) + 100,
            scopes: ["api"],
            idpRefreshToken: "dead-upstream-rt",
        };
        await (
            strategy as unknown as {
                opts: { tokenStore: { issue: (r: GatewayTokenRecord) => Promise<void> } };
            }
        ).opts.tokenStore.issue(seeded);

        const form = new URLSearchParams();
        form.set("grant_type", "refresh_token");
        form.set("refresh_token", "gw-rt-dead");
        form.set("client_id", "seed-client");
        const res = await fetch(`${baseUrl}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, string>;
        expect(body.error).toBe("invalid_grant");
        expect(body.error_description).toBe("upstream_refresh_failed");
    });

    it("falls back to gateway-only rotation when no idpRefreshToken is stored", async () => {
        // Pre-Phase-4 records exist without idp tokens.  Refresh
        // must still work — rotating only the gateway pair is the
        // original behaviour and stays the fallback when the
        // upstream never issued a refresh token in the first place.
        const delegateCalls: string[] = [];
        await startGatewayOAuthServer(() => ({
            ...baseOptions(),
            refreshUpstreamToken: async (rt: string) => {
                delegateCalls.push(rt);
                return { access_token: "should-not-be-used" };
            },
        }));

        const seeded: GatewayTokenRecord = {
            accessToken: "gw-at-legacy",
            refreshToken: "gw-rt-legacy",
            clientId: "seed-client",
            subject: "user-42",
            identity: { bearer: "legacy-bearer", subject: "user-42" },
            expiresAt: Math.floor(Date.now() / 1000) + 100,
            scopes: ["api"],
            // idpRefreshToken deliberately omitted.
        };
        await (
            strategy as unknown as {
                opts: { tokenStore: { issue: (r: GatewayTokenRecord) => Promise<void> } };
            }
        ).opts.tokenStore.issue(seeded);

        const form = new URLSearchParams();
        form.set("grant_type", "refresh_token");
        form.set("refresh_token", "gw-rt-legacy");
        form.set("client_id", "seed-client");
        const res = await fetch(`${baseUrl}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
        });
        expect(res.status).toBe(200);

        // Delegate was NOT called — nothing to refresh.
        expect(delegateCalls).toEqual([]);
    });
});

/* ── Non-OIDC userinfo coverage moved to orchid-api ──────────────
 *
 * The gateway no longer parses upstream userinfo responses — that
 * concern lives on orchid-api (see ``test_auth_identity`` in
 * ``orchid-api`` for the JSON-path extraction tests).  The non-OIDC
 * test that used to live here was deleted with the fetchUserinfo /
 * extractAtPath / coerceClaim helpers.
 */

describe("upstream-secret-free hygiene", () => {
    it("UpstreamIdPConfig has no upstream-secret-or-userinfo fields", () => {
        // Regression guard: a maintainer adding ``tokenEndpoint`` /
        // ``userinfoEndpoint`` / ``clientSecret`` / ``userinfoSubPath``
        // / ``userinfoEmailPath`` back to ``UpstreamIdPConfig`` would
        // re-introduce the Phase-1 fallback paths we deliberately
        // retired.  The shape compares the runtime keys present on a
        // valid options object — the type-level signature would also
        // catch this, but the runtime check trips on stale tests
        // that pass extra fields with type assertions.
        const opts = baseOptions();
        const idpKeys = Object.keys(opts.idp).sort();
        // ``authDomain`` is optional — only present when set.  We
        // assert against the SET of allowed keys instead of a
        // fixed array.
        const allowed = new Set([
            "issuer",
            "authorizationEndpoint",
            "clientId",
            "scopes",
            "authDomain",
        ]);
        for (const key of idpKeys) {
            expect(allowed.has(key)).toBe(true);
        }
    });
});

async function registerClient(): Promise<RegisteredClient> {
    const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            redirect_uris: ["http://localhost:7000/callback"],
        }),
    });
    return (await res.json()) as RegisteredClient;
}

async function runUntilGatewayCode(): Promise<{
    client: RegisteredClient;
    gatewayCode: string;
    verifier: string;
}> {
    const client = await registerClient();
    const verifier = randomBase64Url(64);
    const challenge = sha256Base64Url(verifier);
    const authRes = await fetch(
        `${baseUrl}/authorize?${params({
            client_id: client.client_id,
            redirect_uri: client.redirect_uris[0] ?? "",
            response_type: "code",
            code_challenge: challenge,
            code_challenge_method: "S256",
        })}`,
        { redirect: "manual" },
    );
    const idpUrl = authRes.headers.get("location") ?? "";
    const idpRes = await fetch(idpUrl, { redirect: "manual" });
    const callbackUrl = idpRes.headers.get("location") ?? "";
    const cbRes = await fetch(callbackUrl, { redirect: "manual" });
    const finalUrl = new URL(cbRes.headers.get("location") ?? "");
    const code = finalUrl.searchParams.get("code") ?? "";
    return { client, gatewayCode: code, verifier };
}

async function exchangeCode(
    client: RegisteredClient,
    code: string,
    verifier: string,
): Promise<Response> {
    return fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            client_id: client.client_id,
            redirect_uri: client.redirect_uris[0] ?? "",
        }),
    });
}

function params(obj: Record<string, string>): string {
    return new URLSearchParams(obj).toString();
}

function randomBase64Url(n: number): string {
    return randomBytes(n).toString("base64url");
}

function sha256Base64Url(input: string): string {
    return createHash("sha256").update(input).digest("base64url");
}
