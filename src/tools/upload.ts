/**
 * ``orchid_upload_file`` — upload a single base64-encoded file into the
 * current chat's RAG scope. Auto-binds a fresh chat when the MCP session
 * has none (matches ``orchid_ask`` behaviour for consistency).
 */

import { z } from "zod";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AppContext } from "../context.js";
import type { FileAttachment } from "../http/orchidClient.js";
import {
    buildCallOptions,
    buildRequestContext,
    errorToResult,
    isErrorResult,
    runWithTooling,
    type ToolHandlerExtra,
} from "./_shared.js";

const uploadInputShape = {
    filename: z.string().min(1).describe("The file's name, e.g. ``notes.pdf``."),
    contentB64: z.string().min(1).describe("Base64-encoded file content."),
    mimeType: z
        .string()
        .optional()
        .describe("Optional MIME type; helps server-side parser selection."),
} as const;

type UploadInput = z.infer<z.ZodObject<typeof uploadInputShape>>;

export async function runUploadFile(
    ctx: AppContext,
    extra: ToolHandlerExtra,
    args: UploadInput,
): Promise<CallToolResult> {
    const reqCtx = buildRequestContext(extra);
    try {
        const identity = await ctx.authStrategy.resolve(reqCtx);
        const opts = buildCallOptions(identity);

        let chatId = await ctx.sessionMap.getChatId(reqCtx.mcpSessionId, identity.subject);
        if (chatId === null) {
            const session = await ctx.httpClient.createChat(opts);
            chatId = session.id;
            await ctx.sessionMap.setChatId(reqCtx.mcpSessionId, identity.subject, chatId);
        }

        const file: FileAttachment = {
            filename: args.filename,
            content: Buffer.from(args.contentB64, "base64"),
        };
        if (args.mimeType !== undefined) {
            file.mimeType = args.mimeType;
        }

        const response = await ctx.httpClient.upload(opts, chatId, [file]);
        const entry = response.files[0];

        if (entry !== undefined && "error" in entry) {
            return isErrorResult(`Upload failed for ${args.filename}: ${entry.error}`);
        }
        const chunks = entry !== undefined && "chunks_indexed" in entry ? entry.chunks_indexed : 0;
        return {
            content: [
                {
                    type: "text",
                    text: `Uploaded ${args.filename} to chat ${chatId} (${String(chunks)} chunks indexed).`,
                },
            ],
            structuredContent: {
                kind: "file_uploaded",
                chat_id: chatId,
                filename: args.filename,
                chunks_indexed: chunks,
            },
        };
    } catch (err) {
        return errorToResult(err, ctx, "orchid_upload_file");
    }
}

export function registerUploadFileTool(server: McpServer, ctx: AppContext): RegisteredTool {
    return server.registerTool(
        "orchid_upload_file",
        {
            title: "Upload a file to the current Orchid chat",
            description:
                "Upload a single base64-encoded file into the current chat's RAG scope. Orchid parses, chunks, and indexes the file so subsequent orchid_ask calls can retrieve from it. Auto-creates a chat if none is bound to this MCP session.",
            inputSchema: uploadInputShape,
        },
        async (args, extra) =>
            runWithTooling(ctx, "orchid_upload_file", extra, () => runUploadFile(ctx, extra, args)),
    );
}
