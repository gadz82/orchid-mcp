/**
 * Phase 1 smoke test: proves the vitest + tsx + ESM pipeline actually
 * executes source under ``src/``. Replaced by more specific tests in
 * later phases.
 */

import { describe, expect, it } from "vitest";

import { MCP_SPEC_REVISION } from "../src/server.js";
import { loadSettings } from "../src/settings.js";

describe("settings", () => {
    it("parses an empty env to defaults", () => {
        const settings = loadSettings({});
        expect(settings.orchidApiUrl).toBe("http://localhost:8000");
        expect(settings.authMode).toBe("service_account");
        expect(settings.port).toBe(9000);
        expect(settings.sessionMapBackend).toBe("memory");
    });

    it("maps ORCHID_MCP_* env vars to camelCase fields", () => {
        const settings = loadSettings({
            ORCHID_MCP_ORCHID_API_URL: "http://example.test:1234",
            ORCHID_MCP_AUTH_MODE: "oauth",
            ORCHID_MCP_PORT: "8787",
            ORCHID_MCP_LOG_LEVEL: "debug",
        });
        expect(settings.orchidApiUrl).toBe("http://example.test:1234");
        expect(settings.authMode).toBe("oauth");
        expect(settings.port).toBe(8787);
        expect(settings.logLevel).toBe("debug");
    });

    it("rejects unknown fields (strict)", () => {
        expect(() =>
            loadSettings({
                ORCHID_MCP_NONSENSE_FIELD: "x",
            }),
        ).toThrow();
    });

    it("accepts the Phase 3 oauth store http knobs", () => {
        const settings = loadSettings({
            ORCHID_MCP_OAUTH_STORE_BACKEND: "http",
            ORCHID_MCP_GATEWAY_STATE_SERVICE_TOKEN: "sek-123",
        });
        expect(settings.oauthStoreBackend).toBe("http");
        expect(settings.gatewayStateServiceToken).toBe("sek-123");
    });

    it("defaults oauthStoreBackend to undefined so index.ts picks memory", () => {
        const settings = loadSettings({});
        expect(settings.oauthStoreBackend).toBeUndefined();
        expect(settings.gatewayStateServiceToken).toBeUndefined();
    });

    it("rejects retired Phase-1/4 env vars under strict mode", () => {
        // Phase 5 retired the gateway-side direct-to-IdP fallbacks
        // and the via-api opt-out flags.  Operators with stale env
        // vars get a loud zod error rather than a silent no-op.
        for (const stale of [
            "ORCHID_MCP_OAUTH_CLIENT_SECRET",
            "ORCHID_MCP_OAUTH_TOKEN_ENDPOINT",
            "ORCHID_MCP_OAUTH_USERINFO_ENDPOINT",
            "ORCHID_MCP_OAUTH_USERINFO_SUB_PATH",
            "ORCHID_MCP_OAUTH_USERINFO_EMAIL_PATH",
            "ORCHID_MCP_OAUTH_EXCHANGE_VIA_API",
            "ORCHID_MCP_OAUTH_RESOLVE_VIA_API",
            "ORCHID_MCP_OAUTH_REFRESH_VIA_API",
            "ORCHID_MCP_OAUTH_IDENTITY_RESOLVER_MODULE",
            "ORCHID_MCP_IDENTITY_RESOLVER_MODULE",
        ]) {
            expect(() => loadSettings({ [stale]: "x" })).toThrow();
        }
    });
});

describe("server constants", () => {
    it("pins the MCP spec revision", () => {
        expect(MCP_SPEC_REVISION).toBe("2025-03-26");
    });
});
