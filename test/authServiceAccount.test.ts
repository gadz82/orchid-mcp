import { describe, expect, it } from "vitest";

import type { MCPRequestContext } from "../src/auth/base.js";
import {
    SHARED_SUBJECT,
    ServiceAccountStrategy,
    guardServiceAccountDeployment,
} from "../src/auth/serviceAccount.js";
import { OrchidConfigError } from "../src/errors.js";

const baseCtx: MCPRequestContext = {
    mcpSessionId: "sess-1",
    headers: {},
};

describe("ServiceAccountStrategy", () => {
    it("returns the configured bearer and SHARED_SUBJECT", async () => {
        const s = new ServiceAccountStrategy({ serviceAccountToken: "abc" });
        const identity = await s.resolve(baseCtx);
        expect(identity.bearer).toBe("abc");
        expect(identity.subject).toBe(SHARED_SUBJECT);
        expect(identity.authDomain).toBeUndefined();
        expect(s.mode).toBe("service_account");
    });

    it("propagates authDomain when configured", async () => {
        const s = new ServiceAccountStrategy({
            serviceAccountToken: "abc",
            serviceAccountAuthDomain: "acme.example.com",
        });
        const identity = await s.resolve(baseCtx);
        expect(identity.authDomain).toBe("acme.example.com");
    });

    it("throws OrchidConfigError on an empty token", () => {
        expect(() => new ServiceAccountStrategy({ serviceAccountToken: "" })).toThrow(
            OrchidConfigError,
        );
    });

    it("throws OrchidConfigError on a whitespace-only token", () => {
        expect(() => new ServiceAccountStrategy({ serviceAccountToken: "   " })).toThrow(
            OrchidConfigError,
        );
    });

    it("returns a fresh identity object per call", async () => {
        const s = new ServiceAccountStrategy({ serviceAccountToken: "abc" });
        const a = await s.resolve(baseCtx);
        const b = await s.resolve(baseCtx);
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
});

describe("guardServiceAccountDeployment", () => {
    it("allows oauth mode regardless of host", () => {
        expect(() =>
            guardServiceAccountDeployment({
                authMode: "oauth",
                host: "0.0.0.0",
                iUnderstandTheRisk: false,
            }),
        ).not.toThrow();
    });

    it("allows loopback binds with service_account", () => {
        for (const host of ["127.0.0.1", "localhost", "::1"]) {
            expect(() =>
                guardServiceAccountDeployment({
                    authMode: "service_account",
                    host,
                    iUnderstandTheRisk: false,
                }),
            ).not.toThrow();
        }
    });

    it("refuses 0.0.0.0 with service_account when the risk is not acknowledged", () => {
        expect(() =>
            guardServiceAccountDeployment({
                authMode: "service_account",
                host: "0.0.0.0",
                iUnderstandTheRisk: false,
            }),
        ).toThrow(OrchidConfigError);
    });

    it("refuses :: (IPv6 any) similarly", () => {
        expect(() =>
            guardServiceAccountDeployment({
                authMode: "service_account",
                host: "::",
                iUnderstandTheRisk: false,
            }),
        ).toThrow(OrchidConfigError);
    });

    it("allows 0.0.0.0 when the risk is acknowledged", () => {
        expect(() =>
            guardServiceAccountDeployment({
                authMode: "service_account",
                host: "0.0.0.0",
                iUnderstandTheRisk: true,
            }),
        ).not.toThrow();
    });
});
