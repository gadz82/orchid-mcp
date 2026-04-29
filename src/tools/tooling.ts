/**
 * Tool-handler middleware: correlation, logging, rate limiting, tracing.
 *
 * ``runWithTooling`` is the single entry point every tool body delegates
 * to so the per-request runtime is uniform: a fresh request id, a child
 * pino logger scoped to the tool name + session id, a token-bucket
 * rate-limit check, and an OTEL span. Bypassing it is a bug (per the
 * package's architecture rules).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { MCPRequestContext } from "../auth/base.js";
import type { AppContext } from "../context.js";
import { newRequestId, withCorrelation } from "../observability/correlation.js";
import { withToolSpan } from "../observability/tracing.js";
import { buildRequestContext, type ToolHandlerExtra } from "./context.js";
import { isErrorResult } from "./results.js";

export async function runWithTooling(
    ctx: AppContext,
    toolName: string,
    extra: ToolHandlerExtra,
    body: (reqCtx: MCPRequestContext) => Promise<CallToolResult>,
): Promise<CallToolResult> {
    const reqCtx = buildRequestContext(extra);
    const requestId = newRequestId();
    const logger = ctx.logger.child({
        requestId,
        tool: toolName,
        mcpSessionId: reqCtx.mcpSessionId,
    });
    return withCorrelation({ requestId, mcpSessionId: reqCtx.mcpSessionId, logger }, async () => {
        const decision = ctx.rateLimiter.check(reqCtx.mcpSessionId);
        if (!decision.allowed) {
            const wait = decision.retryAfterMs ?? 1000;
            logger.warn({ retryAfterMs: wait }, "rate limit exceeded");
            return isErrorResult(
                `Rate limit exceeded. Retry in ~${String(Math.ceil(wait / 1000))}s (requestId: ${requestId}).`,
            );
        }
        return withToolSpan(
            `tool.${toolName}`,
            { "mcp.session_id": reqCtx.mcpSessionId, "mcp.request_id": requestId },
            async () => body(reqCtx),
        );
    });
}
