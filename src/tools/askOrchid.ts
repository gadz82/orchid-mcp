/**
 * ``orchid_ask(message, files?)`` — the workhorse tool.
 *
 * Resolves identity, binds-or-reuses a chat id for the current MCP
 * session, decodes base64 attachments, dispatches to ``orchid-api`` via
 * :class:`OrchidAPIClient`, and translates the result into a MCP
 * ``CallToolResult``. HITL interrupts are a normal (non-error) outcome
 * with structured content; authentication/timeout/server failures are
 * ``isError`` with a clear hint.
 */

import { z } from "zod";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { MCPRequestContext } from "../auth/base.js";
import type { AppContext } from "../context.js";
import type {
    CallOptions,
    ChatResponse,
    FileAttachment,
    StreamEvent,
} from "../http/orchidClient.js";
import {
    buildCallOptions,
    chatResult,
    emitProgressNotification,
    errorToResult,
    fetchAuthorizeLinks,
    interruptResult,
    isInterrupt,
    runWithTooling,
    type ToolHandlerExtra,
} from "./_shared.js";

export const askOrchidInputShape = {
    message: z.string().min(1).describe("The user's question or instruction for Orchid."),
    files: z
        .array(
            z.object({
                filename: z.string().min(1),
                contentB64: z.string().min(1).describe("Base64-encoded file contents."),
                mimeType: z.string().optional(),
            }),
        )
        .optional()
        .describe(
            "Optional files to attach to this turn. Orchid indexes them into the current chat's RAG scope.",
        ),
} as const;

type AskOrchidInput = z.infer<z.ZodObject<typeof askOrchidInputShape>>;

const TOOL_TITLE = "Ask Orchid";
const TOOL_DESCRIPTION =
    "Ask Orchid's multi-agent supervisor a question. Routes the question through the upstream agents, " +
    "tools, and RAG pipeline, then returns a synthesised answer. Attached files are indexed into the " +
    "current chat's RAG scope. The current chat is tracked server-side — the host LLM does not need to " +
    "remember a chat id. If Orchid needs approval for a sensitive tool call it returns an interrupt; " +
    "call orchid_resume_chat to continue.";

export function runAskOrchid(
    ctx: AppContext,
    reqCtx: MCPRequestContext,
    args: AskOrchidInput,
    extra?: ToolHandlerExtra,
): Promise<CallToolResult> {
    return askImpl(ctx, reqCtx, args, extra);
}

export function registerAskOrchidTool(server: McpServer, ctx: AppContext): RegisteredTool {
    return server.registerTool(
        "orchid_ask",
        {
            title: TOOL_TITLE,
            description: TOOL_DESCRIPTION,
            inputSchema: askOrchidInputShape,
        },
        async (args, extra: ToolHandlerExtra) =>
            runWithTooling(ctx, "orchid_ask", extra, (reqCtx) => askImpl(ctx, reqCtx, args, extra)),
    );
}

async function askImpl(
    ctx: AppContext,
    reqCtx: MCPRequestContext,
    args: AskOrchidInput,
    extra?: ToolHandlerExtra,
): Promise<CallToolResult> {
    try {
        const identity = await ctx.authStrategy.resolve(reqCtx);
        const callOpts = buildCallOptions(identity);

        let chatId = await ctx.sessionMap.getChatId(reqCtx.mcpSessionId, identity.subject);
        if (chatId === null) {
            const session = await ctx.httpClient.createChat(callOpts);
            chatId = session.id;
            await ctx.sessionMap.setChatId(reqCtx.mcpSessionId, identity.subject, chatId);
        }

        const files: FileAttachment[] = (args.files ?? []).map((f) => {
            const att: FileAttachment = {
                filename: f.filename,
                content: Buffer.from(f.contentB64, "base64"),
            };
            if (f.mimeType !== undefined) {
                att.mimeType = f.mimeType;
            }
            return att;
        });

        const progressToken = extra?._meta?.progressToken;
        const sendNotification = extra?.sendNotification;
        const canStream =
            ctx.settings.streamingEnabled &&
            progressToken !== undefined &&
            typeof sendNotification === "function";

        if (canStream) {
            return await askStreaming(
                ctx,
                reqCtx,
                callOpts,
                chatId,
                args.message,
                files,
                identity.subject,
                progressToken,
                sendNotification,
            );
        }

        const result = await ctx.httpClient.sendMessage(callOpts, chatId, args.message, files);
        if (isInterrupt(result)) {
            await ctx.sessionMap.setPendingInterrupt(
                reqCtx.mcpSessionId,
                identity.subject,
                result.chat_id,
            );
            return interruptResult(result);
        }
        const authLinks = await fetchAuthorizeLinks(
            ctx.httpClient,
            callOpts,
            result.auth_required,
            ctx.logger,
        );
        return chatResult(result, authLinks);
    } catch (err) {
        return errorToResult(err, ctx, "orchid_ask");
    }
}

async function askStreaming(
    ctx: AppContext,
    reqCtx: MCPRequestContext,
    callOpts: CallOptions,
    chatId: string,
    message: string,
    files: FileAttachment[],
    _subject: string,
    progressToken: string | number,
    sendNotification: NonNullable<ToolHandlerExtra["sendNotification"]>,
): Promise<CallToolResult> {
    const intervalMs = ctx.settings.streamingProgressIntervalMs;
    let progress = 0;
    let accumulated = "";
    let lastSent = 0;

    const notify = async (messageText: string, force: boolean): Promise<void> => {
        const now = Date.now();
        if (!force && now - lastSent < intervalMs) return;
        lastSent = now;
        progress += 1;
        try {
            await emitProgressNotification(sendNotification, {
                method: "notifications/progress",
                params: {
                    progressToken,
                    progress,
                    message: messageText,
                },
            });
        } catch {
            // Ignore — a client that closed the connection shouldn't
            // abort the upstream call mid-stream.
        }
    };

    const onEvent = async (event: StreamEvent): Promise<void> => {
        if (event.type === "token") {
            accumulated += event.content;
            await notify(accumulated, false);
        } else if (event.type === "status") {
            await notify(`[${event.agent}] ${event.status}`, true);
        }
        // "done" and "error" are handled by the return/throw from sendMessageStream.
    };

    void reqCtx;
    const done = await ctx.httpClient.sendMessageStream(callOpts, chatId, message, files, {
        onEvent,
    });

    // Flush one last progress so the UI sees the final content before the result.
    await notify(done.response, true);

    const chat: ChatResponse = {
        response: done.response,
        chat_id: chatId,
        tenant_id: "",
        agents_used: done.agents_used,
        auth_required: done.auth_required,
    };
    const authLinks = await fetchAuthorizeLinks(
        ctx.httpClient,
        callOpts,
        done.auth_required,
        ctx.logger,
    );
    return chatResult(chat, authLinks);
}
