/**
 * In-process :class:`SessionMap` backed by two LRU caches — one for the
 * ``(mcpSessionId, subject) → chatId`` binding and one for the
 * pending-interrupt pointer. TTLs evict idle sessions; the max-entries
 * cap bounds memory under a traffic spike.
 */

import { LRUCache } from "lru-cache";

import type { SessionMap } from "./base.js";

export interface MemorySessionMapOptions {
    ttlSeconds: number;
    maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const KEY_SEP = "\u0000";

export class MemorySessionMap implements SessionMap {
    private readonly chatCache: LRUCache<string, string>;
    private readonly pendingCache: LRUCache<string, string>;

    constructor(opts: MemorySessionMapOptions) {
        const ttl = opts.ttlSeconds * 1000;
        const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
        // Use Date as the clock — lru-cache's staleness check has ``!!s``
        // which treats a 0 start time as "untracked", so a value inserted at
        // ``performance.now() === 0`` would never expire. Date.now() returns
        // a real wall-clock timestamp, which is always truthy and also the
        // clock vitest fakes by default.
        this.chatCache = new LRUCache<string, string>({ max, ttl, perf: Date });
        this.pendingCache = new LRUCache<string, string>({ max, ttl, perf: Date });
    }

    async getChatId(mcpSessionId: string, subject: string): Promise<string | null> {
        return this.chatCache.get(this.key(mcpSessionId, subject)) ?? null;
    }

    async setChatId(mcpSessionId: string, subject: string, chatId: string): Promise<void> {
        this.chatCache.set(this.key(mcpSessionId, subject), chatId);
    }

    async clear(mcpSessionId: string, subject: string): Promise<void> {
        const k = this.key(mcpSessionId, subject);
        this.chatCache.delete(k);
        this.pendingCache.delete(k);
    }

    async setPendingInterrupt(
        mcpSessionId: string,
        subject: string,
        chatId: string,
    ): Promise<void> {
        this.pendingCache.set(this.key(mcpSessionId, subject), chatId);
    }

    async popPendingInterrupt(mcpSessionId: string, subject: string): Promise<string | null> {
        const k = this.key(mcpSessionId, subject);
        const val = this.pendingCache.get(k) ?? null;
        if (val !== null) {
            this.pendingCache.delete(k);
        }
        return val;
    }

    private key(mcpSessionId: string, subject: string): string {
        return `${subject}${KEY_SEP}${mcpSessionId}`;
    }
}
