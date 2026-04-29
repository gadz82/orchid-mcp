import { describe, expect, it } from "vitest";

import { NoopRateLimiter, TokenBucketRateLimiter } from "../src/rateLimit.js";

describe("TokenBucketRateLimiter", () => {
    it("allows up to burst tokens immediately", () => {
        const limiter = new TokenBucketRateLimiter({ rpm: 60, burst: 3, now: () => 0 });
        expect(limiter.check("k").allowed).toBe(true);
        expect(limiter.check("k").allowed).toBe(true);
        expect(limiter.check("k").allowed).toBe(true);
        const denied = limiter.check("k");
        expect(denied.allowed).toBe(false);
        expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it("refills at the configured rate", () => {
        let now = 0;
        const limiter = new TokenBucketRateLimiter({ rpm: 60, burst: 1, now: () => now });
        expect(limiter.check("k").allowed).toBe(true);
        expect(limiter.check("k").allowed).toBe(false);
        // 60 rpm = 1 token per second.
        now = 1000;
        expect(limiter.check("k").allowed).toBe(true);
    });

    it("retryAfterMs shrinks as time passes", () => {
        let now = 0;
        const limiter = new TokenBucketRateLimiter({ rpm: 60, burst: 1, now: () => now });
        limiter.check("k");
        const first = limiter.check("k");
        expect(first.allowed).toBe(false);
        now = 500;
        const later = limiter.check("k");
        expect(later.allowed).toBe(false);
        expect(later.retryAfterMs ?? 0).toBeLessThan(first.retryAfterMs ?? Infinity);
    });

    it("isolates keys (different sessions don't share a bucket)", () => {
        const limiter = new TokenBucketRateLimiter({ rpm: 60, burst: 1, now: () => 0 });
        expect(limiter.check("a").allowed).toBe(true);
        expect(limiter.check("b").allowed).toBe(true);
        expect(limiter.check("a").allowed).toBe(false);
        expect(limiter.check("b").allowed).toBe(false);
    });

    it("caps refill at burst size (no infinite accumulation)", () => {
        let now = 0;
        const limiter = new TokenBucketRateLimiter({ rpm: 60, burst: 2, now: () => now });
        // Idle for a long time.
        now = 1_000_000;
        expect(limiter.check("k").allowed).toBe(true);
        expect(limiter.check("k").allowed).toBe(true);
        expect(limiter.check("k").allowed).toBe(false);
    });

    it("rejects invalid configs", () => {
        expect(() => new TokenBucketRateLimiter({ rpm: 0, burst: 1 })).toThrow();
        expect(() => new TokenBucketRateLimiter({ rpm: 1, burst: 0 })).toThrow();
    });
});

describe("NoopRateLimiter", () => {
    it("always allows", () => {
        const limiter = new NoopRateLimiter();
        for (let i = 0; i < 1000; i += 1) {
            expect(limiter.check(`k${String(i)}`).allowed).toBe(true);
        }
    });
});
