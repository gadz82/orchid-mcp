/**
 * Chat-management tools: ``orchid_new_chat``, ``orchid_list_chats``,
 * ``orchid_switch_chat``.
 *
 * Binding semantics: ``new`` and ``switch`` rebind the current MCP
 * session's chat id and clear any pending interrupt from the previous
 * chat (a pending interrupt only makes sense for the chat it came from).
 */

import { z } from "zod";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AppContext } from "../context.js";
import { OrchidServerError } from "../errors.js";
import {
    buildCallOptions,
    buildRequestContext,
    errorToResult,
    isErrorResult,
    runWithTooling,
    type ToolHandlerExtra,
} from "./_shared.js";

/* ── orchid_new_chat ─────────────────────────────────────────── */

const newChatInputShape = {
    title: z
        .string()
        .optional()
        .describe("Optional chat title. Orchid auto-titles from the first message if omitted."),
} as const;

type NewChatInput = z.infer<z.ZodObject<typeof newChatInputShape>>;

export async function runNewChat(
    ctx: AppContext,
    extra: ToolHandlerExtra,
    args: NewChatInput,
): Promise<CallToolResult> {
    const reqCtx = buildRequestContext(extra);
    try {
        const identity = await ctx.authStrategy.resolve(reqCtx);
        const opts = buildCallOptions(identity);
        const session = await ctx.httpClient.createChat(opts, args.title);
        await ctx.sessionMap.setChatId(reqCtx.mcpSessionId, identity.subject, session.id);
        // A pending interrupt belongs to whichever chat raised it; discard it
        // when the session rebinds to a different chat.
        await ctx.sessionMap.popPendingInterrupt(reqCtx.mcpSessionId, identity.subject);
        return {
            content: [
                {
                    type: "text",
                    text: `Started new Orchid chat "${session.title}" (id: ${session.id}). The current MCP session is now bound to it.`,
                },
            ],
            structuredContent: {
                kind: "chat_created",
                chat_id: session.id,
                title: session.title,
            },
        };
    } catch (err) {
        return errorToResult(err, ctx, "orchid_new_chat");
    }
}

/* ── orchid_list_chats ───────────────────────────────────────── */

export async function runListChats(
    ctx: AppContext,
    extra: ToolHandlerExtra,
): Promise<CallToolResult> {
    const reqCtx = buildRequestContext(extra);
    try {
        const identity = await ctx.authStrategy.resolve(reqCtx);
        const opts = buildCallOptions(identity);
        const chats = await ctx.httpClient.listChats(opts);
        const summary =
            chats.length === 0
                ? "You have no Orchid chats yet. Use orchid_new_chat to start one."
                : `${String(chats.length)} chat${chats.length === 1 ? "" : "s"}:\n` +
                  chats
                      .map((c) => `  - "${c.title}" (id: ${c.id}, updated ${c.updated_at})`)
                      .join("\n");
        return {
            content: [{ type: "text", text: summary }],
            structuredContent: {
                kind: "chat_list",
                chats: chats.map((c) => ({
                    chat_id: c.id,
                    title: c.title,
                    created_at: c.created_at,
                    updated_at: c.updated_at,
                    is_shared: c.is_shared,
                })),
            },
        };
    } catch (err) {
        return errorToResult(err, ctx, "orchid_list_chats");
    }
}

/* ── orchid_switch_chat ──────────────────────────────────────── */

const switchChatInputShape = {
    chatId: z.string().min(1).describe("The Orchid chat id to bind the current MCP session to."),
} as const;

type SwitchChatInput = z.infer<z.ZodObject<typeof switchChatInputShape>>;

export async function runSwitchChat(
    ctx: AppContext,
    extra: ToolHandlerExtra,
    args: SwitchChatInput,
): Promise<CallToolResult> {
    const reqCtx = buildRequestContext(extra);
    try {
        const identity = await ctx.authStrategy.resolve(reqCtx);
        const opts = buildCallOptions(identity);

        // Probe ownership: orchid-api returns 404 if the chat doesn't belong
        // to the caller (see orchid-api/orchid_api/routers/chats.py).
        try {
            await ctx.httpClient.getMessages(opts, args.chatId, 1, 0);
        } catch (err) {
            if (err instanceof OrchidServerError && err.status === 404) {
                return isErrorResult(
                    `Chat ${args.chatId} was not found or does not belong to you. ` +
                        `Use orchid_list_chats to see your chats.`,
                );
            }
            throw err;
        }

        await ctx.sessionMap.setChatId(reqCtx.mcpSessionId, identity.subject, args.chatId);
        await ctx.sessionMap.popPendingInterrupt(reqCtx.mcpSessionId, identity.subject);
        return {
            content: [
                { type: "text", text: `Bound the current MCP session to chat ${args.chatId}.` },
            ],
            structuredContent: {
                kind: "chat_switched",
                chat_id: args.chatId,
            },
        };
    } catch (err) {
        return errorToResult(err, ctx, "orchid_switch_chat");
    }
}

/* ── Registration ────────────────────────────────────────────── */

export interface ChatMgmtHandles {
    new: RegisteredTool;
    list: RegisteredTool;
    switch: RegisteredTool;
}

export function registerChatMgmtTools(server: McpServer, ctx: AppContext): ChatMgmtHandles {
    const newTool = server.registerTool(
        "orchid_new_chat",
        {
            title: "Start a new Orchid chat",
            description:
                "Explicitly start a fresh Orchid chat and bind the current MCP session to it. Subsequent orchid_ask calls will target this new chat.",
            inputSchema: newChatInputShape,
        },
        async (args, extra) =>
            runWithTooling(ctx, "orchid_new_chat", extra, () => runNewChat(ctx, extra, args)),
    );

    const listTool = server.registerTool(
        "orchid_list_chats",
        {
            title: "List Orchid chats",
            description:
                "List the user's existing Orchid chats so the host LLM can suggest switching to a prior one.",
        },
        async (extra) =>
            runWithTooling(ctx, "orchid_list_chats", extra as ToolHandlerExtra, () =>
                runListChats(ctx, extra as ToolHandlerExtra),
            ),
    );

    const switchTool = server.registerTool(
        "orchid_switch_chat",
        {
            title: "Switch to an existing Orchid chat",
            description:
                "Bind the current MCP session to an existing Orchid chat. Validates that the chat belongs to the caller.",
            inputSchema: switchChatInputShape,
        },
        async (args, extra) =>
            runWithTooling(ctx, "orchid_switch_chat", extra, () => runSwitchChat(ctx, extra, args)),
    );

    return { new: newTool, list: listTool, switch: switchTool };
}
