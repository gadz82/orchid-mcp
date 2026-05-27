import { describe, expect, it, vi } from "vitest";

import { evaluateUpstreamPosture, verifyUpstreamAuthPosture } from "../src/auth/upstreamPosture.js";
import { OrchidConfigError, OrchidGatewayError } from "../src/errors.js";
import { createLogger } from "../src/observability/logger.js";
import type { AuthInfo } from "../src/http/orchidClient.js";

describe("evaluateUpstreamPosture", () => {
    it("OK: dev_bypass on + service_account", () => {
        const v = evaluateUpstreamPosture(
            { dev_bypass: true, identity_resolver_configured: false },
            "service_account",
        );
        expect(v.ok).toBe(true);
        expect(v.error).toBeUndefined();
        expect(v.warning).toBeUndefined();
    });

    it("OK: dev_bypass off + oauth — standard production path", () => {
        const v = evaluateUpstreamPosture(
            { dev_bypass: false, identity_resolver_configured: true },
            "oauth",
        );
        expect(v.ok).toBe(true);
        expect(v.warning).toBeUndefined();
    });

    it("WARN: dev_bypass on + oauth — works but wasteful", () => {
        const v = evaluateUpstreamPosture(
            { dev_bypass: true, identity_resolver_configured: false },
            "oauth",
        );
        expect(v.ok).toBe(true);
        expect(v.warning).toBeDefined();
        expect(v.warning).toMatch(/dev_bypass/i);
    });

    it("FATAL: dev_bypass off + service_account — upstream will 401", () => {
        const v = evaluateUpstreamPosture(
            { dev_bypass: false, identity_resolver_configured: true },
            "service_account",
        );
        expect(v.ok).toBe(false);
        expect(v.error).toBeDefined();
        expect(v.error).toMatch(/ORCHID_MCP_AUTH_MODE=oauth/);
    });
});

describe("verifyUpstreamAuthPosture", () => {
    const logger = createLogger("silent");

    function fakeClient(result: AuthInfo | Error | Error[]) {
        const queue: (AuthInfo | Error)[] = Array.isArray(result) ? [...result] : [result];
        return {
            getAuthInfo: async (): Promise<AuthInfo> => {
                const next = queue.shift() ?? queue[queue.length - 1]!;
                if (next instanceof Error) throw next;
                return next;
            },
            calls: () => queue.length,
        };
    }

    it("returns quietly on an OK verdict", async () => {
        const client = fakeClient({ dev_bypass: false, identity_resolver_configured: true });
        await verifyUpstreamAuthPosture(client, "oauth", logger);
    });

    it("throws OrchidConfigError on a fatal verdict (no retries)", async () => {
        let calls = 0;
        const client = {
            getAuthInfo: async (): Promise<AuthInfo> => {
                calls += 1;
                return { dev_bypass: false, identity_resolver_configured: true };
            },
        };
        await expect(
            verifyUpstreamAuthPosture(client, "service_account", logger, {
                maxAttempts: 5,
            }),
        ).rejects.toBeInstanceOf(OrchidConfigError);
        expect(calls).toBe(1); // fatal verdicts don't retry
    });

    it("retries on transient errors, then succeeds", async () => {
        let calls = 0;
        const client = {
            getAuthInfo: async (): Promise<AuthInfo> => {
                calls += 1;
                if (calls < 3) throw new OrchidGatewayError("transient");
                return { dev_bypass: true, identity_resolver_configured: false };
            },
        };
        const sleep = vi.fn(async () => {
            /* noop */
        });
        await verifyUpstreamAuthPosture(client, "service_account", logger, {
            maxAttempts: 5,
            delayMs: 1,
            sleep,
        });
        expect(calls).toBe(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("does not throw when upstream stays unreachable after retries", async () => {
        const client = {
            getAuthInfo: async (): Promise<AuthInfo> => {
                throw new OrchidGatewayError("upstream down");
            },
        };
        await verifyUpstreamAuthPosture(client, "oauth", logger, {
            maxAttempts: 3,
            delayMs: 1,
            sleep: async () => {
                /* noop */
            },
        });
        // Returned without throwing — gateway will start and handle
        // the fallout per-session.
    });
});
