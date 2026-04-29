/**
 * MCP tool-result shapers and the auth-link enrichment helper.
 *
 * Tool handlers shouldn't construct ``CallToolResult`` directly — they
 * funnel everything through the helpers here so error mapping, interrupt
 * surfacing, and per-user authorize-link enrichment stay uniform. The
 * fan-out call in :func:`fetchAuthorizeLinks` lives next to its consumer
 * (``chatResult``) because the two together form one cohesive concept:
 * "tell the user what they need to authorize".
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AppContext } from "../context.js";
import {
    OrchidGatewayError,
    OrchidServerError,
    OrchidTimeoutError,
    OrchidUnauthorizedError,
} from "../errors.js";
import type {
    CallOptions,
    ChatResponse,
    InterruptResponse,
    OrchidAuthClient,
    SendResult,
} from "../http/orchidClient.js";
import type { Logger } from "../observability/logger.js";

export function errorToResult(err: unknown, ctx: AppContext, toolName: string): CallToolResult {
    if (err instanceof OrchidUnauthorizedError) {
        return isErrorResult(
            "Upstream Orchid rejected the gateway's credentials. " +
                "If you are the operator, verify ORCHID_MCP_SERVICE_ACCOUNT_TOKEN or re-authenticate " +
                "with the configured identity provider.",
        );
    }
    if (err instanceof OrchidTimeoutError) {
        return isErrorResult(
            "Orchid did not respond in time. Multi-agent runs can be slow — retry the same call, " +
                "or raise ORCHID_MCP_ORCHID_API_TIMEOUT_MS.",
        );
    }
    if (err instanceof OrchidServerError) {
        const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
        return isErrorResult(
            `Orchid returned an error (${String(err.status)}): ${body.slice(0, 500)}`,
        );
    }
    if (err instanceof OrchidGatewayError) {
        ctx.logger.warn({ err, toolName }, "gateway error");
        return isErrorResult(`Gateway error: ${err.message}`);
    }
    ctx.logger.error({ err, toolName }, "unexpected tool error");
    const message = err instanceof Error ? err.message : String(err);
    return isErrorResult(`Unexpected gateway error: ${message}`);
}

export function isErrorResult(text: string): CallToolResult {
    return {
        isError: true,
        content: [{ type: "text", text }],
    };
}

/** Type guard discriminating :class:`InterruptResponse` in a :type:`SendResult`. */
export function isInterrupt(r: SendResult): r is InterruptResponse {
    return "status" in r && r.status === "interrupted";
}

/** Shape an :class:`InterruptResponse` as a (non-error) MCP tool result. */
export function interruptResult(r: InterruptResponse): CallToolResult {
    const summary = r.approvals_needed.length
        ? r.approvals_needed
              .map((a) =>
                  a.agent.length > 0
                      ? `Tool "${a.tool}" (agent: ${a.agent}) is waiting for approval.`
                      : `Tool "${a.tool}" is waiting for approval.`,
              )
              .join(" ")
        : "Orchid paused without naming a specific tool.";
    return {
        content: [
            {
                type: "text",
                text:
                    `Orchid paused for human-in-the-loop approval. ${summary} ` +
                    `Call orchid_resume_chat with approved=true to continue, or approved=false to skip the pending tool call.`,
            },
        ],
        structuredContent: {
            kind: "interrupt",
            chat_id: r.chat_id,
            approvals_needed: r.approvals_needed,
        },
    };
}

/**
 * Enriched authorize-URL entry for a single per-user MCP server
 * listed in :attr:`ChatResponse.auth_required`.
 *
 * ``authorize_url`` is populated on a successful upstream fetch;
 * ``error`` is populated when the enrichment call failed. Exactly one
 * of the two is set. Either way the server name is preserved so the
 * host LLM can still surface a useful message.
 */
export interface AuthorizeLink {
    server: string;
    authorize_url?: string;
    error?: string;
}

/**
 * Fan out to ``GET /mcp/auth/servers/{name}/authorize`` for each
 * per-user MCP server the upstream said needs authorization. Runs all
 * fetches in parallel and degrades gracefully — a failed fetch maps to
 * an :type:`AuthorizeLink` with ``error`` set rather than aborting the
 * tool result, because we'd rather tell the user "authorize this
 * server (URL temporarily unavailable)" than swallow the whole answer.
 */
export async function fetchAuthorizeLinks(
    client: Pick<OrchidAuthClient, "getMcpServerAuthorizeUrl">,
    opts: CallOptions,
    serverNames: readonly string[],
    logger: Logger,
): Promise<AuthorizeLink[]> {
    if (serverNames.length === 0) return [];
    const settled = await Promise.allSettled(
        serverNames.map((name) => client.getMcpServerAuthorizeUrl(opts, name)),
    );
    return settled.map((res, i) => {
        const server = serverNames[i] ?? "";
        if (res.status === "fulfilled") {
            return { server, authorize_url: res.value.authorize_url };
        }
        const message = res.reason instanceof Error ? res.reason.message : String(res.reason);
        logger.warn({ server, err: res.reason }, "failed to fetch authorize URL");
        return { server, error: message };
    });
}

/**
 * Shape a :class:`ChatResponse` as a successful MCP tool result.
 *
 * When ``authLinks`` is non-empty the response is extended with a
 * trailing human-readable block listing the per-user MCP servers the
 * user must authorize (plus any clickable URL we managed to fetch),
 * and the structured content carries the same entries under
 * ``auth_links`` so hosts that parse structured output can render a
 * richer UI. An empty or omitted ``authLinks`` leaves the result
 * identical to the pre-enrichment shape.
 */
export function chatResult(r: ChatResponse, authLinks?: readonly AuthorizeLink[]): CallToolResult {
    const links = authLinks ?? [];
    let text = r.response;
    if (links.length > 0) {
        const lines = links.map((l) =>
            l.authorize_url !== undefined
                ? `- ${l.server}: ${l.authorize_url}`
                : `- ${l.server}: (authorize URL temporarily unavailable${l.error !== undefined ? ` — ${l.error}` : ""})`,
        );
        text +=
            "\n\n---\n" +
            "Orchid needs authorization for the following MCP server(s) before it can complete this task:\n" +
            lines.join("\n") +
            "\nOpen the link(s) above to authorize, then retry your request.";
    }
    const structured: Record<string, unknown> = {
        kind: "chat_response",
        chat_id: r.chat_id,
        agents_used: r.agents_used,
        auth_required: r.auth_required,
    };
    if (links.length > 0) {
        structured.auth_links = links;
    }
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
}
