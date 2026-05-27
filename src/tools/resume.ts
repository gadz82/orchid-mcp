/**
 * ``orchid_resume_chat`` — continue a HITL-paused chat.
 *
 * Reads the most-recent pending-interrupt chat id that :tool:`orchid_ask`
 * recorded for the current MCP session, calls ``POST /chats/{id}/resume``,
 * and shapes the result for the host LLM. If the graph pauses *again*
 * (e.g. a chained tool that also needs approval) the new interrupt is
 * re-registered so another :tool:`orchid_resume_chat` call can continue.
 *
 * Design choice: pop-then-restore-on-error. The pending interrupt is
 * consumed at the start; any upstream failure restores it before
 * surfacing the error, so a transient 500 or a timeout doesn't strand
 * the session.
 */

import { z } from "zod";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AppContext } from "../context.js";
import {
    buildCallOptions,
    buildRequestContext,
    chatResult,
    errorToResult,
    interruptResult,
    isErrorResult,
    isInterrupt,
    runWithTooling,
    type ToolHandlerExtra,
} from "./_shared.js";

const resumeInputShape = {
    approved: z
        .boolean()
        .describe("true to run the paused tool call; false to skip it and continue."),
} as const;

type ResumeInput = z.infer<z.ZodObject<typeof resumeInputShape>>;

export async function runResumeChat(
    ctx: AppContext,
    extra: ToolHandlerExtra,
    args: ResumeInput,
): Promise<CallToolResult> {
    const reqCtx = buildRequestContext(extra);

    let identity;
    try {
        identity = await ctx.authStrategy.resolve(reqCtx);
    } catch (err) {
        return errorToResult(err, ctx, "orchid_resume_chat");
    }

    const pendingChatId = await ctx.sessionMap.popPendingInterrupt(
        reqCtx.mcpSessionId,
        identity.subject,
    );
    if (pendingChatId === null) {
        return isErrorResult(
            "No pending Orchid interrupt to resume in this MCP session. " +
                "Call orchid_ask first — an interrupt only appears when the graph pauses for tool approval.",
        );
    }

    const opts = buildCallOptions(identity);
    try {
        const result = await ctx.httpClient.resume(opts, pendingChatId, args.approved);
        if (isInterrupt(result)) {
            await ctx.sessionMap.setPendingInterrupt(
                reqCtx.mcpSessionId,
                identity.subject,
                result.chat_id,
            );
            return interruptResult(result);
        }
        return chatResult(result);
    } catch (err) {
        // Restore the pending interrupt so the user can retry after a
        // transient upstream failure. The session is only truly "done" once
        // the resume call returns a non-interrupt ChatResponse.
        await ctx.sessionMap.setPendingInterrupt(
            reqCtx.mcpSessionId,
            identity.subject,
            pendingChatId,
        );
        return errorToResult(err, ctx, "orchid_resume_chat");
    }
}

export function registerResumeChatTool(server: McpServer, ctx: AppContext): RegisteredTool {
    return server.registerTool(
        "orchid_resume_chat",
        {
            title: "Resume a paused Orchid chat",
            description:
                "Continue an Orchid chat that paused for human-in-the-loop tool approval. Pass approved=true to run the pending tool or approved=false to skip it. Only valid after orchid_ask returned an interrupt in the current MCP session.",
            inputSchema: resumeInputShape,
        },
        async (args, extra: ToolHandlerExtra) =>
            runWithTooling(ctx, "orchid_resume_chat", extra, () => runResumeChat(ctx, extra, args)),
    );
}
