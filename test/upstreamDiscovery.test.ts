/**
 * Tests for :mod:`src/auth/upstreamDiscovery.ts` — the ``discover``
 * auth-mode path that fetches orchid-api's ``/auth-info`` at boot
 * and merges its ``oauth`` block into the gateway's settings.
 */

import { describe, expect, it, vi } from "vitest";

import {
    applyUpstreamDiscovery,
    fetchAuthInfoWithRetries,
    mergeDiscoveredOAuthSettings,
    type AuthInfoFetcher,
} from "../src/auth/upstreamDiscovery.js";
import { OrchidConfigError, OrchidGatewayError } from "../src/errors.js";
import type { AuthInfo, AuthInfoOAuth } from "../src/http/orchidClient.js";
import { createLogger } from "../src/observability/logger.js";
import { SettingsSchema, type Settings } from "../src/settings.js";

const logger = createLogger("silent");

function makeSettings(overrides: Partial<Record<string, string>> = {}): Settings {
    return SettingsSchema.parse({
        orchidApiUrl: "http://localhost:8000",
        authMode: "discover",
        host: "127.0.0.1",
        port: "9000",
        ...overrides,
    });
}

const validOAuth: AuthInfoOAuth = {
    issuer_url: "https://acme.example.com",
    authorization_endpoint: "https://acme.example.com/oauth2/authorize",
    token_endpoint: "https://acme.example.com/oauth2/token",
    userinfo_endpoint: "https://acme.example.com/manage/v1/user/session",
    client_id: "mcp-gateway",
    scope: "api",
    auth_domain: "acme.example.com",
    exchange_via_api: false,
    resolve_via_api: false,
    refresh_via_api: false,
};

function fetcher(responses: (AuthInfo | Error)[]): AuthInfoFetcher {
    const queue = [...responses];
    return {
        getAuthInfo: async (): Promise<AuthInfo> => {
            const next = queue.shift() ?? queue[queue.length - 1]!;
            if (next instanceof Error) throw next;
            return next;
        },
    };
}

describe("mergeDiscoveredOAuthSettings", () => {
    it("fills missing OAuth settings from the discovered block", () => {
        const base = makeSettings({ authMode: "discover" });
        const merged = mergeDiscoveredOAuthSettings(base, validOAuth);
        expect(merged.oauthIssuerUrl).toBe("https://acme.example.com");
        expect(merged.oauthAuthorizationEndpoint).toBe("https://acme.example.com/oauth2/authorize");
        expect(merged.oauthClientId).toBe("mcp-gateway");
        expect(merged.oauthScopes).toBe("api");
    });

    it("env-var values override discovery (precedence: env wins)", () => {
        const base = makeSettings({
            oauthIssuerUrl: "https://operator-override.example.com",
            oauthClientId: "operator-id",
        });
        const merged = mergeDiscoveredOAuthSettings(base, validOAuth);
        expect(merged.oauthIssuerUrl).toBe("https://operator-override.example.com");
        expect(merged.oauthClientId).toBe("operator-id");
        // Unset fields still come from discovery.
        expect(merged.oauthAuthorizationEndpoint).toBe("https://acme.example.com/oauth2/authorize");
    });

    it("leaves the default scopes alone when discovery returns empty scope", () => {
        const base = makeSettings();
        const merged = mergeDiscoveredOAuthSettings(base, { ...validOAuth, scope: "" });
        expect(merged.oauthScopes).toBe("openid profile email");
    });

    it("discovery overrides the default scopes value", () => {
        const base = makeSettings(); // default scopes = "openid profile email"
        const merged = mergeDiscoveredOAuthSettings(base, validOAuth);
        expect(merged.oauthScopes).toBe("api");
    });

    it("preserves a non-default operator-set scopes value", () => {
        const base = makeSettings({ oauthScopes: "custom-scope" });
        const merged = mergeDiscoveredOAuthSettings(base, validOAuth);
        expect(merged.oauthScopes).toBe("custom-scope");
    });

    it("populates platform authDomain from discovery", () => {
        const base = makeSettings();
        const merged = mergeDiscoveredOAuthSettings(base, validOAuth);
        expect(merged.oauthAuthDomain).toBe("acme.example.com");
    });

    it("env-var oauthAuthDomain wins over discovery", () => {
        const base = makeSettings({ oauthAuthDomain: "operator-override.example.com" });
        const merged = mergeDiscoveredOAuthSettings(base, validOAuth);
        expect(merged.oauthAuthDomain).toBe("operator-override.example.com");
    });

    it("ignores ``token_endpoint`` / ``userinfo_endpoint`` / via-api flags from discovery", () => {
        // The gateway no longer holds direct-to-IdP code paths;
        // these fields stay on the wire schema for downstream
        // consumers (orchid-frontend) but the gateway must not
        // attempt to consume them — the merge has nowhere to put
        // them now, so this is a regression guard against any
        // future maintainer who tries to "wire them up again".
        const base = makeSettings();
        const merged = mergeDiscoveredOAuthSettings(base, {
            ...validOAuth,
            exchange_via_api: false,
            resolve_via_api: false,
            refresh_via_api: false,
        });
        // The merged Settings type no longer carries any of these
        // fields, so even attempting to read them is a TS error —
        // good.  We assert on a representative non-flag field
        // surviving instead, to prove the merge ran.
        expect(merged.oauthIssuerUrl).toBe("https://acme.example.com");
    });
});

describe("fetchAuthInfoWithRetries", () => {
    it("returns the first successful response without retrying", async () => {
        const client = fetcher([
            { dev_bypass: false, identity_resolver_configured: true, oauth: validOAuth },
        ]);
        const info = await fetchAuthInfoWithRetries(client, logger);
        expect(info.oauth).toEqual(validOAuth);
    });

    it("retries on transient errors and eventually succeeds", async () => {
        const client = fetcher([
            new OrchidGatewayError("transient"),
            new OrchidGatewayError("still down"),
            { dev_bypass: false, identity_resolver_configured: true, oauth: validOAuth },
        ]);
        const sleep = vi.fn(async () => {
            /* noop */
        });
        const info = await fetchAuthInfoWithRetries(client, logger, {
            delayMs: 1,
            sleep,
            maxAttempts: 5,
        });
        expect(info.oauth).toEqual(validOAuth);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("throws OrchidConfigError after exhausting attempts", async () => {
        let calls = 0;
        const client: AuthInfoFetcher = {
            getAuthInfo: async () => {
                calls += 1;
                throw new OrchidGatewayError("upstream down");
            },
        };
        await expect(
            fetchAuthInfoWithRetries(client, logger, {
                delayMs: 1,
                sleep: async () => {
                    /* noop */
                },
                maxAttempts: 3,
            }),
        ).rejects.toBeInstanceOf(OrchidConfigError);
        expect(calls).toBe(3);
    });
});

describe("applyUpstreamDiscovery", () => {
    it("passes through when authMode is not 'discover'", async () => {
        const base = makeSettings({ authMode: "service_account" });
        const client = fetcher([{ dev_bypass: true, identity_resolver_configured: false }]);
        const spy = vi.spyOn(client, "getAuthInfo");
        const out = await applyUpstreamDiscovery(base, client, logger);
        expect(out).toBe(base);
        expect(spy).not.toHaveBeenCalled();
    });

    it("resolves discovery and upgrades authMode to 'oauth'", async () => {
        const base = makeSettings({ authMode: "discover" });
        const client = fetcher([
            { dev_bypass: false, identity_resolver_configured: true, oauth: validOAuth },
        ]);
        const out = await applyUpstreamDiscovery(base, client, logger);
        expect(out.authMode).toBe("oauth");
        expect(out.oauthIssuerUrl).toBe("https://acme.example.com");
        expect(out.oauthClientId).toBe("mcp-gateway");
    });

    it("throws when upstream omits the oauth block", async () => {
        const base = makeSettings({ authMode: "discover" });
        const client = fetcher([{ dev_bypass: false, identity_resolver_configured: true }]);
        await expect(
            applyUpstreamDiscovery(base, client, logger, { maxAttempts: 1 }),
        ).rejects.toThrow(/did not return an ``oauth`` block/);
    });

    it("throws when upstream returns an empty client_id", async () => {
        const base = makeSettings({ authMode: "discover" });
        const client = fetcher([
            {
                dev_bypass: false,
                identity_resolver_configured: true,
                oauth: { ...validOAuth, client_id: "" },
            },
        ]);
        await expect(
            applyUpstreamDiscovery(base, client, logger, { maxAttempts: 1 }),
        ).rejects.toThrow(/empty ``oauth.client_id``/);
    });

    it("propagates retry exhaustion as OrchidConfigError", async () => {
        const base = makeSettings({ authMode: "discover" });
        const client: AuthInfoFetcher = {
            getAuthInfo: async () => {
                throw new OrchidGatewayError("upstream down");
            },
        };
        await expect(
            applyUpstreamDiscovery(base, client, logger, {
                maxAttempts: 2,
                delayMs: 1,
                sleep: async () => {
                    /* noop */
                },
            }),
        ).rejects.toBeInstanceOf(OrchidConfigError);
    });
});
