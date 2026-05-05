/**
 * End-to-end wiring test: drives the gateway through the SDK's
 * ``StreamableHTTPClientTransport`` to prove that ``initialize`` works
 * and ``orchid_ask`` reaches the tool handler.
 */

import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthStrategy, MCPRequestContext, OrchidIdentity } from "../src/auth/base.js";
import { SHARED_SUBJECT } from "../src/auth/serviceAccount.js";
import type { AppContext } from "../src/context.js";
import { OrchidUnauthorizedError } from "../src/errors.js";
import type {
    CallOptions,
    ChatMessage,
    ChatSession,
    FileAttachment,
    OrchidAPIClient,
    SendResult,
    StreamDoneEvent,
    StreamHandlers,
    UploadResponse,
} from "../src/http/orchidClient.js";
import { createLogger } from "../src/observability/logger.js";
import { NoopRateLimiter } from "../src/rateLimit.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { MemorySessionMap } from "../src/sessions/memory.js";

class StubAuthStrategy implements AuthStrategy {
    readonly mode = "service_account" as const;
    async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
        return { bearer: "tok", subject: SHARED_SUBJECT };
    }
}

class StubClient implements OrchidAPIClient {
    sendCalls = 0;
    async createChat(_opts: CallOptions, _title?: string): Promise<ChatSession> {
        return {
            id: "chat-1",
            title: "Test",
            created_at: "t",
            updated_at: "t",
            is_shared: false,
        };
    }
    async listChats(_opts: CallOptions): Promise<ChatSession[]> {
        return [];
    }
    async getMessages(
        _opts: CallOptions,
        _chatId: string,
        _limit?: number,
        _offset?: number,
    ): Promise<ChatMessage[]> {
        return [];
    }
    async sendMessage(
        _opts: CallOptions,
        _chatId: string,
        _message: string,
        _files?: FileAttachment[],
    ): Promise<SendResult> {
        this.sendCalls += 1;
        return {
            response: "stub answer",
            chat_id: "chat-1",
            tenant_id: "t1",
            agents_used: ["stub"],
            auth_required: [],
        };
    }
    async sendMessageStream(
        _opts: CallOptions,
        _chatId: string,
        _message: string,
        _files: FileAttachment[] | undefined,
        _handlers: StreamHandlers,
    ): Promise<StreamDoneEvent> {
        throw new Error("unused");
    }
    async resume(_opts: CallOptions, _chatId: string, _approved: boolean): Promise<SendResult> {
        throw new Error("unused");
    }
    async upload(
        _opts: CallOptions,
        _chatId: string,
        _files: FileAttachment[],
    ): Promise<UploadResponse> {
        throw new Error("unused");
    }
    async getGatewayConfig(): Promise<{
        tools: Record<string, never>;
        prompts: never[];
    }> {
        return { tools: {}, prompts: [] };
    }
    async getAuthInfo(): Promise<{
        dev_bypass: boolean;
        identity_resolver_configured: boolean;
    }> {
        return { dev_bypass: true, identity_resolver_configured: false };
    }
    async getMcpServerAuthorizeUrl(
        _opts: CallOptions,
        _serverName: string,
    ): Promise<{ authorize_url: string; state: string }> {
        return { authorize_url: "https://idp.test/authorize", state: "s" };
    }
    async exchangeAuthorizationCode(): Promise<{
        access_token: string;
        token_type: string;
    }> {
        throw new Error("exchangeAuthorizationCode not used in these tests");
    }
    async resolveIdentity(): Promise<{
        subject: string;
        bearer: string;
        auth_domain: string;
        email: string;
        extra: Record<string, unknown>;
    }> {
        throw new Error("resolveIdentity not used in these tests");
    }
    async refreshUpstreamToken(): Promise<{
        access_token: string;
        token_type: string;
    }> {
        throw new Error("refreshUpstreamToken not used in these tests");
    }
    async close(): Promise<void> {
        /* noop */
    }
}

async function startGateway(
    stubClient: StubClient,
): Promise<{ url: string; built: BuiltServer; stop: () => Promise<void> }> {
    const ctx: AppContext = {
        settings: {} as AppContext["settings"],
        logger: createLogger("silent"),
        httpClient: stubClient,
        sessionMap: new MemorySessionMap({ ttlSeconds: 60 }),
        authStrategy: new StubAuthStrategy(),
        rateLimiter: new NoopRateLimiter(),
    };
    const built = await buildServer({ ctx });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", resolve));
    const addr = built.httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${String(addr.port)}/mcp`;
    const stop = async (): Promise<void> => {
        await built.close();
        await new Promise<void>((resolve) => built.httpServer.close(() => resolve()));
    };
    return { url, built, stop };
}

describe("Streamable HTTP server", () => {
    let stopGateway: (() => Promise<void>) | null = null;
    let client: Client | null = null;
    let stub: StubClient;

    beforeEach(() => {
        stub = new StubClient();
    });

    afterEach(async () => {
        if (client !== null) {
            await client.close().catch(() => {
                /* ignore */
            });
            client = null;
        }
        if (stopGateway !== null) {
            await stopGateway();
            stopGateway = null;
        }
    });

    it("responds to initialize and lists orchid_ask", async () => {
        const { url, stop } = await startGateway(stub);
        stopGateway = stop;

        client = new Client({ name: "test", version: "0.0.1" });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        // MCP SDK v1.24: StreamableHTTPClientTransport's `sessionId` getter
        // returns `string | undefined` while the `Transport` interface types
        // it as `string | <absent>` — the cast bridges that.
        await client.connect(transport as unknown as Transport);

        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name);
        expect(names).toContain("orchid_ask");
    });

    it("invokes orchid_ask end-to-end through the transport", async () => {
        const { url, stop } = await startGateway(stub);
        stopGateway = stop;

        client = new Client({ name: "test", version: "0.0.1" });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        // MCP SDK v1.24: StreamableHTTPClientTransport's `sessionId` getter
        // returns `string | undefined` while the `Transport` interface types
        // it as `string | <absent>` — the cast bridges that.
        await client.connect(transport as unknown as Transport);

        const result = await client.callTool({
            name: "orchid_ask",
            arguments: { message: "tell me a basketball fact" },
        });

        expect(result.isError).toBeFalsy();
        expect(Array.isArray(result.content)).toBe(true);
        const content = result.content as { type: string; text?: string }[];
        expect(content[0]).toMatchObject({ type: "text", text: "stub answer" });
        expect(stub.sendCalls).toBe(1);
    });
});

describe("Streamable HTTP server — /health", () => {
    let stopGateway: (() => Promise<void>) | null = null;
    let stub: StubClient;

    beforeEach(() => {
        stub = new StubClient();
    });

    afterEach(async () => {
        if (stopGateway !== null) {
            await stopGateway();
            stopGateway = null;
        }
    });

    it("returns status=ok regardless of MCP session state", async () => {
        const { built, stop } = await startGateway(stub);
        stopGateway = stop;
        const addr = built.httpServer.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${String(addr.port)}/health`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.service).toBe("orchid-mcp");
    });
});

describe("Streamable HTTP server — transport error paths", () => {
    let stopGateway: (() => Promise<void>) | null = null;
    let baseUrl = "";

    beforeEach(async () => {
        const { built, stop } = await startGateway(new StubClient());
        stopGateway = stop;
        const addr = built.httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${String(addr.port)}`;
    });

    afterEach(async () => {
        if (stopGateway !== null) {
            await stopGateway();
            stopGateway = null;
        }
    });

    it("returns 400 for POST /mcp without a session id that isn't an initialize", async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("bad_request");
    });

    it("returns 400 for POST /mcp with malformed JSON", async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: "{not json",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("bad_request");
    });

    it("returns 404 for GET /mcp with an unknown session id", async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: "GET",
            headers: { "mcp-session-id": "does-not-exist", Accept: "text/event-stream" },
        });
        expect(res.status).toBe(404);
    });

    it("returns 400 for GET /mcp with no session id", async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: "GET",
            headers: { Accept: "text/event-stream" },
        });
        expect(res.status).toBe(400);
    });

    it("returns 405 for PUT /mcp", async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toMatch(/POST/);
    });

    it("returns 404 for unknown paths", async () => {
        const res = await fetch(`${baseUrl}/nonsense`);
        expect(res.status).toBe(404);
    });
});

// ── Session-fixation guard ────────────────────────────────────
//
// A session ID + transport pair created by user A must NOT be
// reachable to user B even when B knows the UUID. The gateway
// pins each session to its initiator's :attr:`OrchidIdentity.subject`
// and returns 403 on mismatch.

class _PerBearerAuthStrategy implements AuthStrategy {
    readonly mode = "service_account" as const;
    private readonly subjectByBearer: Record<string, string>;
    constructor(subjectByBearer: Record<string, string>) {
        this.subjectByBearer = subjectByBearer;
    }
    async resolve(ctx: MCPRequestContext): Promise<OrchidIdentity> {
        const bearer = ctx.accessToken ?? "";
        const subject = this.subjectByBearer[bearer];
        if (subject === undefined) {
            throw new OrchidUnauthorizedError(`unknown bearer: ${bearer}`);
        }
        return { bearer, subject };
    }
}

async function _startGatewayWithAuth(
    stubClient: StubClient,
    auth: AuthStrategy,
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
    const ctx: AppContext = {
        settings: {} as AppContext["settings"],
        logger: createLogger("silent"),
        httpClient: stubClient,
        sessionMap: new MemorySessionMap({ ttlSeconds: 60 }),
        authStrategy: auth,
        rateLimiter: new NoopRateLimiter(),
    };
    const built = await buildServer({ ctx });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", resolve));
    const addr = built.httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
    const stop = async (): Promise<void> => {
        await built.close();
        await new Promise<void>((resolve) => built.httpServer.close(() => resolve()));
    };
    return { baseUrl, stop };
}

describe("Streamable HTTP server — session-fixation guard", () => {
    let stopGateway: (() => Promise<void>) | null = null;
    let baseUrl = "";

    beforeEach(async () => {
        const auth = new _PerBearerAuthStrategy({
            "tok-A": "subject-A",
            "tok-B": "subject-B",
        });
        const { baseUrl: url, stop } = await _startGatewayWithAuth(new StubClient(), auth);
        stopGateway = stop;
        baseUrl = url;
    });

    afterEach(async () => {
        if (stopGateway !== null) {
            await stopGateway();
            stopGateway = null;
        }
    });

    async function _initializeAs(bearer: string): Promise<string> {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: `Bearer ${bearer}`,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "test", version: "0.0.1" },
                },
            }),
        });
        expect(res.status).toBe(200);
        const sessionId = res.headers.get("mcp-session-id");
        expect(sessionId).not.toBeNull();
        // Drain the SSE body so the connection is closed cleanly.
        await res.text();
        return sessionId as string;
    }

    it("rejects POST /mcp when bearer subject differs from initiator", async () => {
        const sessionId = await _initializeAs("tok-A");

        const res = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                "mcp-session-id": sessionId,
                Authorization: "Bearer tok-B",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        });

        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("session_subject_mismatch");
    });

    it("rejects GET /mcp when bearer subject differs from initiator", async () => {
        const sessionId = await _initializeAs("tok-A");

        const res = await fetch(`${baseUrl}/mcp`, {
            method: "GET",
            headers: {
                Accept: "text/event-stream",
                "mcp-session-id": sessionId,
                Authorization: "Bearer tok-B",
            },
        });

        expect(res.status).toBe(403);
    });

    it("rejects DELETE /mcp when bearer subject differs from initiator", async () => {
        const sessionId = await _initializeAs("tok-A");

        const res = await fetch(`${baseUrl}/mcp`, {
            method: "DELETE",
            headers: {
                "mcp-session-id": sessionId,
                Authorization: "Bearer tok-B",
            },
        });

        expect(res.status).toBe(403);
    });

    it("accepts POST /mcp from the initiator's own bearer", async () => {
        const sessionId = await _initializeAs("tok-A");

        const res = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                "mcp-session-id": sessionId,
                Authorization: "Bearer tok-A",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        });

        // Same-subject reuse goes through; 200/202 is fine — what matters
        // is we did NOT see the 403 reserved for cross-user reuse.
        expect(res.status).not.toBe(403);
    });
});

// ── HTTP-layer auth enforcement (MCP 2025-03-26) ──────────────
//
// The /mcp endpoint MUST return 401 + WWW-Authenticate on
// unauthenticated requests in OAuth mode, so clients (Cursor,
// Claude Desktop) can discover the AS via RFC 9728 and run the
// auth dance.  A gateway that silently accepts unauthenticated
// ``initialize`` calls strands the client in ``auth=unknown``
// state — real regression seen in the field.
describe("Streamable HTTP server — OAuth-mode auth enforcement", () => {
    /** Auth strategy that always reports the client as unauthenticated. */
    class UnauthenticatedStrategy implements AuthStrategy {
        readonly mode = "oauth" as const;
        async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
            throw new OrchidUnauthorizedError("Missing Bearer token.");
        }
    }

    async function startUnauthedGateway(): Promise<{
        baseUrl: string;
        stop: () => Promise<void>;
    }> {
        const ctx: AppContext = {
            settings: {
                oauthGatewayBaseUrl: "http://gateway.test",
            } as AppContext["settings"],
            logger: createLogger("silent"),
            httpClient: new StubClient(),
            sessionMap: new MemorySessionMap({ ttlSeconds: 60 }),
            authStrategy: new UnauthenticatedStrategy(),
            rateLimiter: new NoopRateLimiter(),
        };
        const built = await buildServer({ ctx });
        await new Promise<void>((resolve) =>
            built.httpServer.listen(0, "127.0.0.1", resolve),
        );
        const addr = built.httpServer.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
        const stop = async (): Promise<void> => {
            await built.close();
            await new Promise<void>((resolve) => built.httpServer.close(() => resolve()));
        };
        return { baseUrl, stop };
    }

    let stopGateway: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (stopGateway !== null) {
            await stopGateway();
            stopGateway = null;
        }
    });

    it("returns 401 + WWW-Authenticate on POST /mcp without a bearer", async () => {
        const { baseUrl, stop } = await startUnauthedGateway();
        stopGateway = stop;

        const res = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "probe", version: "0.0.1" },
                },
            }),
        });

        expect(res.status).toBe(401);
        const wwwAuth = res.headers.get("www-authenticate");
        expect(wwwAuth).not.toBeNull();
        expect(wwwAuth).toContain("Bearer");
        expect(wwwAuth).toContain(
            'resource_metadata="http://gateway.test/.well-known/oauth-protected-resource"',
        );
        const body = (await res.json()) as { error: string; error_description: string };
        expect(body.error).toBe("unauthorized");
        expect(body.error_description).toMatch(/Missing Bearer/i);
    });

    it("returns 401 + WWW-Authenticate on GET /mcp without a bearer", async () => {
        const { baseUrl, stop } = await startUnauthedGateway();
        stopGateway = stop;

        const res = await fetch(`${baseUrl}/mcp`, {
            method: "GET",
            headers: {
                Accept: "text/event-stream",
                "mcp-session-id": "does-not-exist",
            },
        });

        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toContain("Bearer");
    });

    it("returns 401 + WWW-Authenticate on DELETE /mcp without a bearer", async () => {
        const { baseUrl, stop } = await startUnauthedGateway();
        stopGateway = stop;

        const res = await fetch(`${baseUrl}/mcp`, {
            method: "DELETE",
            headers: { "mcp-session-id": "does-not-exist" },
        });

        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toContain("Bearer");
    });

    it("emits a bare Bearer challenge when oauthGatewayBaseUrl is unset", async () => {
        // Degenerate but possible — service_account mode doesn't set a
        // gateway base URL, and an OAuth misconfiguration could leave
        // it absent.  We still return 401, just without the metadata
        // pointer; callers will at least see the realm.
        const ctx: AppContext = {
            settings: {} as AppContext["settings"],
            logger: createLogger("silent"),
            httpClient: new StubClient(),
            sessionMap: new MemorySessionMap({ ttlSeconds: 60 }),
            authStrategy: new UnauthenticatedStrategy(),
            rateLimiter: new NoopRateLimiter(),
        };
        const built = await buildServer({ ctx });
        await new Promise<void>((resolve) =>
            built.httpServer.listen(0, "127.0.0.1", resolve),
        );
        const addr = built.httpServer.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
        stopGateway = async (): Promise<void> => {
            await built.close();
            await new Promise<void>((resolve) => built.httpServer.close(() => resolve()));
        };

        const res = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "probe", version: "0.0.1" },
                },
            }),
        });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
    });

    it("service_account mode still accepts unauthenticated /mcp requests", async () => {
        // Service account auth never rejects — the strategy always
        // returns the pre-configured shared bearer.  So no 401 even
        // without client-supplied auth.  Sanity check that the new
        // enforcement gate doesn't break this mode.
        const { url, stop } = await startGateway(new StubClient());
        stopGateway = stop;
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "probe", version: "0.0.1" },
                },
            }),
        });
        expect(res.status).toBe(200);
    });
});
