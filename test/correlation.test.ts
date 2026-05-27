import { describe, expect, it } from "vitest";

import {
    getCorrelation,
    getCorrelationLogger,
    getRequestId,
    newRequestId,
    withCorrelation,
} from "../src/observability/correlation.js";
import { createLogger } from "../src/observability/logger.js";

describe("correlation context", () => {
    it("is empty outside of withCorrelation", () => {
        expect(getCorrelation()).toBeUndefined();
        expect(getRequestId()).toBeUndefined();
        expect(getCorrelationLogger()).toBeUndefined();
    });

    it("exposes the bound fields inside withCorrelation", async () => {
        const logger = createLogger("silent");
        await withCorrelation({ requestId: "req-1", mcpSessionId: "sess-1", logger }, async () => {
            expect(getRequestId()).toBe("req-1");
            expect(getCorrelation()?.mcpSessionId).toBe("sess-1");
            expect(getCorrelationLogger()).toBe(logger);
        });
    });

    it("isolates concurrent async contexts", async () => {
        const logger = createLogger("silent");
        const tasks = await Promise.all([
            withCorrelation({ requestId: "req-a", mcpSessionId: "s", logger }, async () => {
                await new Promise((r) => setTimeout(r, 5));
                return getRequestId();
            }),
            withCorrelation({ requestId: "req-b", mcpSessionId: "s", logger }, async () => {
                return getRequestId();
            }),
        ]);
        expect(tasks).toEqual(["req-a", "req-b"]);
    });

    it("unwinds cleanly on error", async () => {
        const logger = createLogger("silent");
        await expect(
            withCorrelation({ requestId: "req-x", mcpSessionId: "s", logger }, async () => {
                throw new Error("oops");
            }),
        ).rejects.toThrow(/oops/);
        expect(getCorrelation()).toBeUndefined();
    });

    it("generates request ids with a sensible prefix", () => {
        const id = newRequestId();
        expect(id).toMatch(/^req-/);
        expect(id.length).toBeGreaterThan(10);
    });
});
