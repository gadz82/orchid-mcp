import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemorySessionMap } from "../src/sessions/memory.js";

describe("MemorySessionMap", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("round-trips chat ids per (session, subject) pair", async () => {
        const map = new MemorySessionMap({ ttlSeconds: 60 });
        await map.setChatId("sess-1", "user-a", "chat-aaa");
        await map.setChatId("sess-1", "user-b", "chat-bbb");
        await map.setChatId("sess-2", "user-a", "chat-ccc");

        expect(await map.getChatId("sess-1", "user-a")).toBe("chat-aaa");
        expect(await map.getChatId("sess-1", "user-b")).toBe("chat-bbb");
        expect(await map.getChatId("sess-2", "user-a")).toBe("chat-ccc");
    });

    it("returns null for unknown bindings", async () => {
        const map = new MemorySessionMap({ ttlSeconds: 60 });
        expect(await map.getChatId("sess-1", "user-a")).toBeNull();
    });

    it("overwrites an existing binding for the same pair", async () => {
        const map = new MemorySessionMap({ ttlSeconds: 60 });
        await map.setChatId("s", "u", "chat-1");
        await map.setChatId("s", "u", "chat-2");
        expect(await map.getChatId("s", "u")).toBe("chat-2");
    });

    it("expires entries after the TTL", async () => {
        const map = new MemorySessionMap({ ttlSeconds: 10 });
        await map.setChatId("s", "u", "chat-1");
        vi.advanceTimersByTime(9_999);
        expect(await map.getChatId("s", "u")).toBe("chat-1");
        vi.advanceTimersByTime(2);
        expect(await map.getChatId("s", "u")).toBeNull();
    });

    it("clear() removes the chat binding and any pending interrupt", async () => {
        const map = new MemorySessionMap({ ttlSeconds: 60 });
        await map.setChatId("s", "u", "chat-1");
        await map.setPendingInterrupt("s", "u", "chat-1");

        await map.clear("s", "u");

        expect(await map.getChatId("s", "u")).toBeNull();
        expect(await map.popPendingInterrupt("s", "u")).toBeNull();
    });

    it("clear() is scoped to the (session, subject) pair", async () => {
        const map = new MemorySessionMap({ ttlSeconds: 60 });
        await map.setChatId("s", "user-a", "chat-a");
        await map.setChatId("s", "user-b", "chat-b");

        await map.clear("s", "user-a");

        expect(await map.getChatId("s", "user-a")).toBeNull();
        expect(await map.getChatId("s", "user-b")).toBe("chat-b");
    });

    it("pending interrupts are one-shot", async () => {
        const map = new MemorySessionMap({ ttlSeconds: 60 });
        await map.setPendingInterrupt("s", "u", "chat-x");

        expect(await map.popPendingInterrupt("s", "u")).toBe("chat-x");
        expect(await map.popPendingInterrupt("s", "u")).toBeNull();
    });

    it("pending interrupts don't leak across subjects", async () => {
        const map = new MemorySessionMap({ ttlSeconds: 60 });
        await map.setPendingInterrupt("s", "user-a", "chat-a");

        expect(await map.popPendingInterrupt("s", "user-b")).toBeNull();
        expect(await map.popPendingInterrupt("s", "user-a")).toBe("chat-a");
    });

    it("pending interrupts expire with the TTL", async () => {
        const map = new MemorySessionMap({ ttlSeconds: 5 });
        await map.setPendingInterrupt("s", "u", "chat-y");
        vi.advanceTimersByTime(5_001);
        expect(await map.popPendingInterrupt("s", "u")).toBeNull();
    });
});
