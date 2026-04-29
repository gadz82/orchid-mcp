import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { readRawBody } from "../src/auth/oauth.js";

/**
 * Build a fake ``IncomingMessage`` good enough for ``readRawBody``.
 *
 * The function only uses ``on`` / ``removeListener`` (via EventEmitter) plus
 * ``destroy``. Tracking listener counts and the ``destroyed`` flag lets us
 * assert that the listener cleanup actually runs after settlement.
 */
function makeFakeReq(): {
    req: IncomingMessage;
    destroyed: () => boolean;
    listenerCounts: () => Record<string, number>;
} {
    const emitter = new EventEmitter();
    let destroyed = false;
    Object.assign(emitter, {
        destroy(this: IncomingMessage, _error?: Error): IncomingMessage {
            destroyed = true;
            return this;
        },
    });
    return {
        req: emitter as unknown as IncomingMessage,
        destroyed: () => destroyed,
        listenerCounts: () => ({
            data: emitter.listenerCount("data"),
            end: emitter.listenerCount("end"),
            error: emitter.listenerCount("error"),
            aborted: emitter.listenerCount("aborted"),
        }),
    };
}

describe("readRawBody", () => {
    it("resolves with the concatenated body on a normal end event", async () => {
        const { req, listenerCounts } = makeFakeReq();
        const promise = readRawBody(req);

        // Emit the body in two chunks then end.
        process.nextTick(() => {
            req.emit("data", Buffer.from("hello "));
            req.emit("data", Buffer.from("world"));
            req.emit("end");
        });

        await expect(promise).resolves.toBe("hello world");

        // After settlement the function MUST have removed its listeners so
        // late events don't leak memory or trigger handlers.
        const counts = listenerCounts();
        expect(counts.data).toBe(0);
        expect(counts.end).toBe(0);
        expect(counts.error).toBe(0);
        expect(counts.aborted).toBe(0);
    });

    it("rejects with 'body too large' once the limit is exceeded", async () => {
        const { req, destroyed } = makeFakeReq();
        const promise = readRawBody(req);

        // 1.5 MB chunk — well over the 1 MB ceiling baked into readRawBody.
        process.nextTick(() => {
            req.emit("data", Buffer.alloc(1.5 * 1024 * 1024));
        });

        await expect(promise).rejects.toThrow("body too large");
        expect(destroyed()).toBe(true);
    });

    it("settles exactly once when 'end' races after the limit is exceeded", async () => {
        const { req, listenerCounts } = makeFakeReq();
        const promise = readRawBody(req);

        process.nextTick(() => {
            req.emit("data", Buffer.alloc(2 * 1024 * 1024));
            // Simulate the late ``end`` fire that motivated the race fix.
            req.emit("end");
        });

        await expect(promise).rejects.toThrow("body too large");

        // Listeners are removed after the first settle, so the late ``end``
        // event is observed by zero handlers — no second settlement.
        const counts = listenerCounts();
        expect(counts.data).toBe(0);
        expect(counts.end).toBe(0);
    });

    it("rejects when the underlying stream errors", async () => {
        const { req } = makeFakeReq();
        const promise = readRawBody(req);

        process.nextTick(() => {
            req.emit("error", new Error("ECONNRESET"));
        });

        await expect(promise).rejects.toThrow("ECONNRESET");
    });

    it("rejects when the client aborts before completion", async () => {
        const { req, listenerCounts } = makeFakeReq();
        const promise = readRawBody(req);

        process.nextTick(() => {
            req.emit("data", Buffer.from("partial"));
            req.emit("aborted");
        });

        await expect(promise).rejects.toThrow("client aborted");

        // Ensure no chunks accumulate after the abort settles the promise.
        const initial = listenerCounts();
        expect(initial.data).toBe(0);

        // A late ``data`` chunk arriving after abort must NOT crash — it has
        // no listener anymore. Emitting events with no listeners is a no-op
        // for EventEmitter.
        expect(() => req.emit("data", Buffer.alloc(8 * 1024 * 1024))).not.toThrow();
    });

    it("does not double-resolve when 'end' arrives after a prior settlement", async () => {
        const { req } = makeFakeReq();
        const promise = readRawBody(req);

        let settledCount = 0;
        promise.then(() => settledCount++, () => settledCount++);

        process.nextTick(() => {
            req.emit("data", Buffer.from("one"));
            req.emit("end");
            req.emit("end"); // late duplicate
        });

        await promise;
        // Wait a microtask so any pathological re-resolve would have fired.
        await new Promise((r) => setTimeout(r, 0));
        expect(settledCount).toBe(1);
    });
});
