/**
 * Gateway HTTP + MCP server.
 *
 * ``/health`` is a plain probe. ``/mcp`` implements the MCP Streamable
 * HTTP transport in stateful mode — each client gets its own MCP session
 * id which we key the session map on (see AD-3 in the plan). One
 * :class:`McpServer` instance + one :class:`StreamableHTTPServerTransport`
 * per session; both are torn down on ``onclose``.
 */

import { randomUUID } from "node:crypto";
import {
    createServer as createHttpServer,
    type IncomingMessage,
    type Server as HttpServer,
    type ServerResponse,
} from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { AuthRoute, MCPRequestContext, OrchidIdentity } from "./auth/base.js";
import type { AppContext } from "./context.js";
import { OrchidUnauthorizedError } from "./errors.js";
import type { GatewayConfig } from "./http/orchidClient.js";
import { applyGatewayConfig } from "./mcpGateway/applyConfig.js";
import { registerTools } from "./tools/registry.js";

/**
 * MCP spec revision this gateway targets. Pin here so an SDK upgrade
 * that silently advances the spec is caught by a grep. See the plan's
 * risk note on "MCP SDK churn".
 */
export const MCP_SPEC_REVISION = "2025-03-26";
export const GATEWAY_NAME = "orchid-mcp";
export const GATEWAY_VERSION = "0.1.0-dev";

/** Cap incoming MCP request bodies — prevents a hostile client from OOMing the gateway. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface BuildServerDeps {
    ctx: AppContext;
}

export interface BuiltServer {
    httpServer: HttpServer;
    close: () => Promise<void>;
}

export async function buildServer(deps: BuildServerDeps): Promise<BuiltServer> {
    const { ctx } = deps;
    const { logger } = ctx;

    const transports = new Map<string, StreamableHTTPServerTransport>();
    const servers = new Map<string, McpServer>();

    const handleMcpPost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        let body: unknown;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            writeJson(res, 400, {
                error: "bad_request",
                message: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        // ── HTTP-layer auth gate ──────────────────────────────
        // Per MCP 2025-03-26, every ``/mcp`` request must be
        // authenticated.  We enforce it BEFORE the SDK transport so
        // an unauthenticated client gets a 401 + ``WWW-Authenticate``
        // header and knows to run the OAuth discovery flow — the SDK
        // would otherwise happily reply to ``initialize`` without a
        // bearer and the client would never start the dance.  Service
        // account strategies always succeed, so this is a no-op in
        // that mode.
        const identity = await enforceHttpAuth(req, res, ctx);
        if (identity === null) return;

        const sessionId = getSessionIdHeader(req);

        if (sessionId !== null) {
            const existing = transports.get(sessionId);
            if (existing !== undefined) {
                await existing.handleRequest(req, res, body);
                return;
            }
        }

        if (sessionId === null && isInitializeRequest(body)) {
            const mcpServer = new McpServer(
                { name: GATEWAY_NAME, version: GATEWAY_VERSION },
                { capabilities: { tools: {}, prompts: {} } },
            );
            const toolHandles = registerTools(mcpServer, ctx);

            // Best-effort: fetch the integrator's MCP-gateway config
            // and apply tool title/description overrides + register
            // prompts. Uses the identity we resolved above (via the
            // HTTP-layer gate), so no re-resolve here.
            const gatewayConfig = await tryFetchGatewayConfig(identity, ctx);
            if (gatewayConfig !== null) {
                applyGatewayConfig(mcpServer, toolHandles, gatewayConfig, logger);
            }

            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    transports.set(sid, transport);
                    servers.set(sid, mcpServer);
                    logger.info({ sessionId: sid }, "mcp session initialized");
                },
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid !== undefined) {
                    transports.delete(sid);
                    servers.delete(sid);
                    logger.info({ sessionId: sid }, "mcp session closed");
                }
            };

            try {
                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, body);
            } catch (err) {
                logger.error({ err }, "failed to initialize mcp session");
                if (!res.headersSent) {
                    writeJson(res, 500, { error: "session_init_failed" });
                }
            }
            return;
        }

        writeJson(res, 400, {
            error: "bad_request",
            message:
                "Missing or unknown mcp-session-id, and the request is not an initialize call. " +
                "New clients must start with initialize.",
        });
    };

    const handleMcpGetOrDelete = async (
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> => {
        // Same HTTP-layer auth enforcement as handleMcpPost — the SSE
        // stream (GET) and session-delete (DELETE) paths must not be
        // reachable without a valid bearer in OAuth mode.
        const identity = await enforceHttpAuth(req, res, ctx);
        if (identity === null) return;

        const sessionId = getSessionIdHeader(req);
        if (sessionId === null) {
            writeJson(res, 400, { error: "missing_session_id" });
            return;
        }
        const transport = transports.get(sessionId);
        if (transport === undefined) {
            writeJson(res, 404, { error: "unknown_session" });
            return;
        }
        await transport.handleRequest(req, res);
    };

    const authRoutes = ctx.authStrategy.httpRoutes?.() ?? [];

    const httpServer = createHttpServer((req, res) => {
        void handleRequest(req, res, {
            handleMcpPost,
            handleMcpGetOrDelete,
            authRoutes,
            logger,
        });
    });

    logger.info(
        {
            mcpSpec: MCP_SPEC_REVISION,
            name: GATEWAY_NAME,
            version: GATEWAY_VERSION,
        },
        "MCP server built",
    );

    const close = async (): Promise<void> => {
        const entries = Array.from(transports.entries());
        for (const [sid, transport] of entries) {
            try {
                await transport.close();
            } catch (err) {
                logger.warn({ sid, err }, "failed to close transport on shutdown");
            }
        }
        for (const mcpServer of Array.from(servers.values())) {
            try {
                await mcpServer.close();
            } catch (err) {
                logger.warn({ err }, "failed to close mcp server on shutdown");
            }
        }
        transports.clear();
        servers.clear();
    };

    return { httpServer, close };
}

async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    handlers: {
        handleMcpPost: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
        handleMcpGetOrDelete: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
        authRoutes: AuthRoute[];
        logger: AppContext["logger"];
    },
): Promise<void> {
    try {
        const path = (req.url ?? "").split("?")[0];

        // Auth strategy routes (OAuth metadata, /authorize, /token, etc.) take
        // precedence over the built-in routes so the strategy owns its paths.
        for (const route of handlers.authRoutes) {
            if (route.path === path && route.method === req.method) {
                await route.handle(req, res);
                return;
            }
        }

        if (path === "/health" || path === "/healthz") {
            writeJson(res, 200, {
                status: "ok",
                service: GATEWAY_NAME,
                version: GATEWAY_VERSION,
                mcpSpec: MCP_SPEC_REVISION,
            });
            return;
        }
        if (path === "/mcp") {
            if (req.method === "POST") {
                await handlers.handleMcpPost(req, res);
                return;
            }
            if (req.method === "GET" || req.method === "DELETE") {
                await handlers.handleMcpGetOrDelete(req, res);
                return;
            }
            res.writeHead(405, { "Content-Type": "application/json", Allow: "POST, GET, DELETE" });
            res.end(JSON.stringify({ error: "method_not_allowed" }));
            return;
        }
        writeJson(res, 404, { error: "not_found" });
    } catch (err) {
        handlers.logger.error({ err }, "unhandled request error");
        if (!res.headersSent) {
            writeJson(res, 500, { error: "internal_error" });
        }
    }
}

/**
 * HTTP-layer auth enforcement for ``/mcp`` requests.
 *
 * Wraps :meth:`AuthStrategy.resolve` so a failure turns into a
 * ``401 + WWW-Authenticate: Bearer resource_metadata="..."`` response
 * (MCP 2025-03-26 compliant) instead of slipping through to the SDK
 * transport.  Clients that don't yet have a bearer pick up the
 * metadata URL from the header, run DCR + authorize flow, and retry.
 *
 * Returns the resolved :type:`OrchidIdentity` on success.  Returns
 * ``null`` when a 401 has been written — callers must return
 * immediately without doing further I/O on ``res``.
 */
export async function enforceHttpAuth(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: AppContext,
): Promise<OrchidIdentity | null> {
    const reqCtx: MCPRequestContext = {
        mcpSessionId: getSessionIdHeader(req) ?? "pre-init",
        headers: normalizeHeaders(req.headers),
    };
    const bearer = bearerFromAuthHeader(reqCtx.headers.authorization);
    if (bearer !== undefined) {
        reqCtx.accessToken = bearer;
    }
    try {
        return await ctx.authStrategy.resolve(reqCtx);
    } catch (err) {
        if (err instanceof OrchidUnauthorizedError) {
            writeUnauthorized(res, ctx, err.message);
            return null;
        }
        throw err;
    }
}

function writeUnauthorized(res: ServerResponse, ctx: AppContext, detail: string): void {
    const baseUrl = ctx.settings.oauthGatewayBaseUrl;
    // The ``resource_metadata`` parameter points the client at the
    // RFC 9728 document, which in turn announces the AS.  Without a
    // base URL we fall back to a bare ``Bearer`` challenge — rare in
    // practice because OAuth mode always ships with a base URL.
    const wwwAuth =
        baseUrl !== undefined
            ? `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
            : "Bearer";
    res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": wwwAuth,
    });
    res.end(JSON.stringify({ error: "unauthorized", error_description: detail }));
}

async function tryFetchGatewayConfig(
    identity: OrchidIdentity,
    ctx: AppContext,
): Promise<GatewayConfig | null> {
    try {
        const opts: { bearer: string; authDomain?: string } = { bearer: identity.bearer };
        if (identity.authDomain !== undefined) {
            opts.authDomain = identity.authDomain;
        }
        return await ctx.httpClient.getGatewayConfig(opts);
    } catch (err) {
        ctx.logger.warn(
            { err },
            "could not fetch mcp-gateway config at session init; using defaults",
        );
        return null;
    }
}

function normalizeHeaders(
    raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (v === undefined) continue;
        out[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? "") : v;
    }
    return out;
}

function bearerFromAuthHeader(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!value.toLowerCase().startsWith("bearer ")) return undefined;
    const token = value.slice(7).trim();
    return token.length > 0 ? token : undefined;
}

function getSessionIdHeader(req: IncomingMessage): string | null {
    const raw = req.headers["mcp-session-id"];
    if (Array.isArray(raw)) {
        return raw[0] ?? null;
    }
    return raw ?? null;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
        let total = 0;
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                req.destroy();
                reject(new Error(`Request body exceeds ${String(MAX_BODY_BYTES)} bytes`));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const full = Buffer.concat(chunks).toString("utf8");
            if (full.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(full));
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
        req.on("error", reject);
    });
}
