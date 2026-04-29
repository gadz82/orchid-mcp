/**
 * Per-MCP-session token-bucket rate limiter.
 *
 * Keyed on ``mcpSessionId``. Rejected calls are returned as tool-level
 * ``isError`` results — the MCP transport is JSON-RPC, not HTTP, so the
 * usual 429 pattern doesn't apply. A Redis-backed implementation lands
 * when we move beyond single-replica deployments; the narrow
 * :class:`RateLimiter` interface keeps that swap purely additive.
 */

import { LRUCache } from "lru-cache";

export interface RateLimitDecision {
    allowed: boolean;
    /** When ``allowed=false``, how many ms until the next token is available. */
    retryAfterMs?: number;
    /** Current token count (useful for observability / tests). */
    remaining: number;
}

export interface RateLimiter {
    check(key: string): RateLimitDecision;
}

interface Bucket {
    tokens: number;
    lastRefill: number;
}

export interface TokenBucketOptions {
    /** Sustained rate in tokens per minute. */
    rpm: number;
    /** Maximum token accumulation (burst). */
    burst: number;
    /** Cap on distinct keys tracked before LRU eviction. */
    maxKeys?: number;
    /** Clock override for tests — defaults to ``Date.now``. */
    now?: () => number;
}

export class TokenBucketRateLimiter implements RateLimiter {
    private readonly buckets: LRUCache<string, Bucket>;
    private readonly ratePerMs: number;
    private readonly burst: number;
    private readonly now: () => number;

    constructor(opts: TokenBucketOptions) {
        if (opts.rpm <= 0 || opts.burst <= 0) {
            throw new Error("TokenBucketRateLimiter requires rpm > 0 and burst > 0");
        }
        this.ratePerMs = opts.rpm / 60_000;
        this.burst = opts.burst;
        this.now = opts.now ?? Date.now;
        this.buckets = new LRUCache<string, Bucket>({
            max: opts.maxKeys ?? 10_000,
            ttl: 60 * 60 * 1000, // drop idle keys after an hour
            perf: Date,
        });
    }

    check(key: string): RateLimitDecision {
        const now = this.now();
        let bucket = this.buckets.get(key);
        if (bucket === undefined) {
            bucket = { tokens: this.burst, lastRefill: now };
            this.buckets.set(key, bucket);
        } else {
            const elapsed = now - bucket.lastRefill;
            if (elapsed > 0) {
                bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.ratePerMs);
                bucket.lastRefill = now;
            }
        }
        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return { allowed: true, remaining: Math.floor(bucket.tokens) };
        }
        const retryAfterMs = Math.ceil((1 - bucket.tokens) / this.ratePerMs);
        return { allowed: false, retryAfterMs, remaining: 0 };
    }
}

/** Unlimited limiter — used when rate limiting is disabled. */
export class NoopRateLimiter implements RateLimiter {
    check(_key: string): RateLimitDecision {
        return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    }
}
