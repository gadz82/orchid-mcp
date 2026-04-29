/**
 * Tool registration entry point.
 *
 * All six v1 tools land here. Adding a new tool = a new
 * ``register<Something>Tool(server, ctx)`` call; the tool file owns its
 * own zod schema, handler, and structured-content shape.
 *
 * Returns a map of ``{toolName → handle}`` so the caller can apply
 * integrator-supplied title/description overrides from the
 * ``GatewayConfig`` after registration (via
 * :func:`applyGatewayConfig`).
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "../context.js";
import type { ToolUpdateHandle } from "../mcpGateway/applyConfig.js";
import { registerAskOrchidTool } from "./askOrchid.js";
import { registerChatMgmtTools } from "./chatMgmt.js";
import { registerResumeChatTool } from "./resume.js";
import { registerUploadFileTool } from "./upload.js";

export function registerTools(
    server: McpServer,
    ctx: AppContext,
): Map<string, ToolUpdateHandle> {
    const handles = new Map<string, RegisteredTool>();
    handles.set("orchid_ask", registerAskOrchidTool(server, ctx));
    const chatMgmt = registerChatMgmtTools(server, ctx);
    handles.set("orchid_new_chat", chatMgmt.new);
    handles.set("orchid_list_chats", chatMgmt.list);
    handles.set("orchid_switch_chat", chatMgmt.switch);
    handles.set("orchid_upload_file", registerUploadFileTool(server, ctx));
    handles.set("orchid_resume_chat", registerResumeChatTool(server, ctx));
    return handles as Map<string, ToolUpdateHandle>;
}
