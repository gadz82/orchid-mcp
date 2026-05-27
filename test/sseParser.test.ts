import { describe, expect, it } from "vitest";

import { parseSSE, type SSEEvent } from "../src/http/sseParser.js";

function streamFromStrings(parts: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) {
                controller.enqueue(encoder.encode(part));
            }
            controller.close();
        },
    });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
    const out: SSEEvent[] = [];
    for await (const ev of parseSSE(stream)) {
        out.push(ev);
    }
    return out;
}

describe("parseSSE", () => {
    it("parses a single message event", async () => {
        const events = await collect(streamFromStrings(["data: hello\n\n"]));
        expect(events).toEqual([{ event: "message", data: "hello" }]);
    });

    it("dispatches multiple events separated by blank lines", async () => {
        const events = await collect(
            streamFromStrings(["data: one\n\n", "event: tick\ndata: two\n\n"]),
        );
        expect(events).toEqual([
            { event: "message", data: "one" },
            { event: "tick", data: "two" },
        ]);
    });

    it("joins multi-line data fields with newlines", async () => {
        const events = await collect(streamFromStrings(["data: line1\ndata: line2\n\n"]));
        expect(events).toEqual([{ event: "message", data: "line1\nline2" }]);
    });

    it("handles a payload split across chunk boundaries", async () => {
        const events = await collect(streamFromStrings(["data: hel", "lo\n", "\n"]));
        expect(events).toEqual([{ event: "message", data: "hello" }]);
    });

    it("ignores comment lines (starting with :)", async () => {
        const events = await collect(streamFromStrings([": keepalive\n", "data: payload\n\n"]));
        expect(events).toEqual([{ event: "message", data: "payload" }]);
    });

    it("ignores unknown fields and keeps id sticky across events", async () => {
        const events = await collect(
            streamFromStrings(["id: 1\nretry: 5000\ndata: first\n\n", "data: second\n\n"]),
        );
        expect(events).toEqual([
            { event: "message", data: "first", id: "1" },
            { event: "message", data: "second", id: "1" },
        ]);
    });

    it("handles \\r\\n, \\r, and \\n as line terminators", async () => {
        const events = await collect(
            streamFromStrings(["data: a\r\n\r\ndata: b\rdata: b2\r\rdata: c\n\n"]),
        );
        expect(events).toEqual([
            { event: "message", data: "a" },
            { event: "message", data: "b\nb2" },
            { event: "message", data: "c" },
        ]);
    });

    it("does not dispatch an event when the stream ends without a blank line", async () => {
        const events = await collect(streamFromStrings(["data: incomplete\n"]));
        expect(events).toEqual([]);
    });

    it("handles a field name without a colon separator (colonIdx === -1)", async () => {
        const events = await collect(streamFromStrings(["data\n\n"]));
        expect(events).toEqual([{ event: "message", data: "" }]);
    });
});
