import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
    type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withToolSpan } from "../src/observability/tracing.js";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
    trace.disable();
    await provider.shutdown();
});

describe("withToolSpan", () => {
    it("creates one span per invocation with the given name + attributes", async () => {
        await withToolSpan(
            "tool.test",
            { "mcp.session_id": "sess-1", "mcp.request_id": "req-9" },
            async () => "ok",
        );
        const spans = exporter.getFinishedSpans() as unknown as ReadableSpan[];
        expect(spans).toHaveLength(1);
        expect(spans[0]?.name).toBe("tool.test");
        expect(spans[0]?.attributes["mcp.session_id"]).toBe("sess-1");
        expect(spans[0]?.attributes["mcp.request_id"]).toBe("req-9");
        expect(spans[0]?.status.code).toBe(SpanStatusCode.OK);
    });

    it("marks the span as ERROR and records the exception on throw", async () => {
        await expect(
            withToolSpan("tool.bad", { "mcp.session_id": "s" }, async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow(/boom/);
        const spans = exporter.getFinishedSpans() as unknown as ReadableSpan[];
        expect(spans).toHaveLength(1);
        expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
        expect(spans[0]?.status.message).toBe("boom");
        expect(spans[0]?.events.some((e: { name: string }) => e.name === "exception")).toBe(true);
    });

    it("supports nested spans", async () => {
        await withToolSpan("outer", { "mcp.session_id": "s" }, async () => {
            await withToolSpan("inner", { "mcp.session_id": "s" }, async () => "ok");
        });
        const spans = exporter.getFinishedSpans() as unknown as ReadableSpan[];
        expect(spans.map((s) => s.name).sort()).toEqual(["inner", "outer"]);
    });
});
