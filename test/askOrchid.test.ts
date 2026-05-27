import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthStrategy, MCPRequestContext, OrchidIdentity } from "../src/auth/base.js";
import { SHARED_SUBJECT } from "../src/auth/serviceAccount.js";
import type { AppContext } from "../src/context.js";
import {
    OrchidGatewayError,
    OrchidServerError,
    OrchidTimeoutError,
    OrchidUnauthorizedError,
} from "../src/errors.js";
import type {
    CallOptions,
    ChatMessage,
    ChatSession,
    FileAttachment,
    McpServerAuthorize,
    OrchidAPIClient,
    SendResult,
    StreamDoneEvent,
    StreamHandlers,
    UploadResponse,
} from "../src/http/orchidClient.js";
import { createLogger } from "../src/observability/logger.js";
import { NoopRateLimiter } from "../src/rateLimit.js";
import { MemorySessionMap } from "../src/sessions/memory.js";
import { runAskOrchid } from "../src/tools/askOrchid.js";

import { eventsNoop } from "./_helpers/stubEvents.js";

/* ── Fakes ───────────────────────────────────────────────────── */

class FakeAuthStrategy implements AuthStrategy {
    readonly mode = "service_account" as const;
    calls = 0;
    constructor(private readonly identity: OrchidIdentity) {}
    async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
        this.calls += 1;
        return this.identity;
    }
}

interface SendCall {
    opts: CallOptions;
    chatId: string;
    message: string;
    files: FileAttachment[];
}

class FakeOrchidAPIClient implements OrchidAPIClient {
    createChatCalls: { opts: CallOptions; title?: string }[] = [];
    sendCalls: SendCall[] = [];
    nextChatSession: ChatSession = {
        id: "chat-new",
        title: "New chat",
        created_at: "t",
        updated_at: "t",
        is_shared: false,
    };
    nextSendResult: SendResult | Error = {
        response: "pong",
        chat_id: "chat-1",
        tenant_id: "t1",
        agents_used: [],
        auth_required: [],
    };
    async createChat(opts: CallOptions, title?: string): Promise<ChatSession> {
        const call: { opts: CallOptions; title?: string } = { opts };
        if (title !== undefined) {
            call.title = title;
        }
        this.createChatCalls.push(call);
        return this.nextChatSession;
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
        opts: CallOptions,
        chatId: string,
        message: string,
        files: FileAttachment[] = [],
    ): Promise<SendResult> {
        this.sendCalls.push({ opts, chatId, message, files });
        if (this.nextSendResult instanceof Error) {
            throw this.nextSendResult;
        }
        return this.nextSendResult;
    }
    async sendMessageStream(
        _opts: CallOptions,
        _chatId: string,
        _message: string,
        _files: FileAttachment[] | undefined,
        _handlers: StreamHandlers,
    ): Promise<StreamDoneEvent> {
        throw new Error("not used in these tests");
    }
    async resume(_opts: CallOptions, _chatId: string, _approved: boolean): Promise<SendResult> {
        throw new Error("not used in these tests");
    }
    async upload(
        _opts: CallOptions,
        _chatId: string,
        _files: FileAttachment[],
    ): Promise<UploadResponse> {
        throw new Error("not used in these tests");
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
    /**
     * Per-server override. Missing keys fall back to a default
     * ``https://idp.test/authorize?server={name}`` URL. Error values
     * are thrown — letting tests exercise graceful-degradation paths.
     */
    authorizeStubs = new Map<string, McpServerAuthorize | Error>();
    authorizeCalls: { opts: CallOptions; serverName: string }[] = [];
    async getMcpServerAuthorizeUrl(
        opts: CallOptions,
        serverName: string,
    ): Promise<McpServerAuthorize> {
        this.authorizeCalls.push({ opts, serverName });
        const stub = this.authorizeStubs.get(serverName);
        if (stub instanceof Error) throw stub;
        if (stub !== undefined) return stub;
        return {
            authorize_url: `https://idp.test/authorize?server=${encodeURIComponent(serverName)}`,
            state: "s",
        };
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
    emitSignal = eventsNoop().emitSignal;
    getRun = eventsNoop().getRun;
    listRuns = eventsNoop().listRuns;
    listRunsForSignal = eventsNoop().listRunsForSignal;
}

/* ── Harness ─────────────────────────────────────────────────── */

function makeCtx(
    overrides: {
        identity?: OrchidIdentity;
        sessionMap?: MemorySessionMap;
        httpClient?: FakeOrchidAPIClient;
    } = {},
): { ctx: AppContext; httpClient: FakeOrchidAPIClient; sessionMap: MemorySessionMap } {
    const identity = overrides.identity ?? {
        bearer: "tok-xyz",
        subject: SHARED_SUBJECT,
    };
    const authStrategy = new FakeAuthStrategy(identity);
    const httpClient = overrides.httpClient ?? new FakeOrchidAPIClient();
    const sessionMap = overrides.sessionMap ?? new MemorySessionMap({ ttlSeconds: 60 });
    const ctx: AppContext = {
        // Partial settings — runAskOrchid only reads ctx.logger, httpClient, sessionMap, authStrategy.
        settings: {} as AppContext["settings"],
        logger: createLogger("silent"),
        httpClient,
        sessionMap,
        authStrategy,
        rateLimiter: new NoopRateLimiter(),
    };
    return { ctx, httpClient, sessionMap };
}

const reqCtx: MCPRequestContext = { mcpSessionId: "sess-1", headers: {} };

/* ── Tests ───────────────────────────────────────────────────── */

describe("runAskOrchid — happy path", () => {
    it("creates a chat on first call and binds it to the session", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        httpClient.nextChatSession = {
            id: "chat-abc",
            title: "New chat",
            created_at: "t",
            updated_at: "t",
            is_shared: false,
        };
        httpClient.nextSendResult = {
            response: "LeBron has career highs of …",
            chat_id: "chat-abc",
            tenant_id: "t1",
            agents_used: ["basketball"],
            auth_required: [],
        };

        const result = await runAskOrchid(ctx, reqCtx, { message: "Tell me about LeBron" });

        expect(httpClient.createChatCalls).toHaveLength(1);
        expect(httpClient.sendCalls).toHaveLength(1);
        expect(httpClient.sendCalls[0]?.chatId).toBe("chat-abc");
        expect(await sessionMap.getChatId("sess-1", SHARED_SUBJECT)).toBe("chat-abc");
        expect(result.isError).toBeFalsy();
        expect(result.content?.[0]).toMatchObject({
            type: "text",
            text: "LeBron has career highs of …",
        });
        expect(result.structuredContent).toMatchObject({
            kind: "chat_response",
            chat_id: "chat-abc",
            agents_used: ["basketball"],
            auth_required: [],
        });
    });

    it("reuses the bound chat on subsequent calls in the same session", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextChatSession = {
            id: "chat-abc",
            title: "",
            created_at: "t",
            updated_at: "t",
            is_shared: false,
        };
        httpClient.nextSendResult = {
            response: "first",
            chat_id: "chat-abc",
            tenant_id: "t",
            agents_used: [],
            auth_required: [],
        };
        await runAskOrchid(ctx, reqCtx, { message: "first" });
        httpClient.nextSendResult = {
            response: "second",
            chat_id: "chat-abc",
            tenant_id: "t",
            agents_used: [],
            auth_required: [],
        };
        await runAskOrchid(ctx, reqCtx, { message: "second" });

        expect(httpClient.createChatCalls).toHaveLength(1);
        expect(httpClient.sendCalls).toHaveLength(2);
        expect(httpClient.sendCalls[1]?.chatId).toBe("chat-abc");
    });

    it("does NOT share chats across sessions", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextChatSession = {
            id: "chat-A",
            title: "",
            created_at: "t",
            updated_at: "t",
            is_shared: false,
        };
        httpClient.nextSendResult = {
            response: "ok",
            chat_id: "chat-A",
            tenant_id: "t",
            agents_used: [],
            auth_required: [],
        };
        await runAskOrchid(ctx, { mcpSessionId: "sess-A", headers: {} }, { message: "a" });
        httpClient.nextChatSession = {
            id: "chat-B",
            title: "",
            created_at: "t",
            updated_at: "t",
            is_shared: false,
        };
        await runAskOrchid(ctx, { mcpSessionId: "sess-B", headers: {} }, { message: "b" });

        expect(httpClient.createChatCalls).toHaveLength(2);
        expect(httpClient.sendCalls.map((c) => c.chatId)).toEqual(["chat-A", "chat-B"]);
    });

    it("propagates the authDomain through to the upstream call", async () => {
        const { ctx, httpClient } = makeCtx({
            identity: {
                bearer: "tok",
                authDomain: "acme.example.com",
                subject: SHARED_SUBJECT,
            },
        });
        await runAskOrchid(ctx, reqCtx, { message: "hi" });
        expect(httpClient.createChatCalls[0]?.opts.authDomain).toBe("acme.example.com");
        expect(httpClient.sendCalls[0]?.opts.authDomain).toBe("acme.example.com");
    });
});

describe("runAskOrchid — auth_required enrichment", () => {
    it("does not fetch authorize URLs when auth_required is empty", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextSendResult = {
            response: "ok",
            chat_id: "chat-1",
            tenant_id: "t",
            agents_used: [],
            auth_required: [],
        };
        const result = await runAskOrchid(ctx, reqCtx, { message: "hi" });
        expect(httpClient.authorizeCalls).toHaveLength(0);
        // Structured content omits auth_links when no enrichment happened.
        expect(result.structuredContent).not.toHaveProperty("auth_links");
    });

    it("enriches a single-server auth_required with an authorize URL", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextSendResult = {
            response: "I can help once you authorize GitHub.",
            chat_id: "chat-1",
            tenant_id: "t",
            agents_used: ["assistant"],
            auth_required: ["github"],
        };
        httpClient.authorizeStubs.set("github", {
            authorize_url: "https://idp.example.com/oauth/authorize?svc=github",
            state: "gh-state",
        });

        const result = await runAskOrchid(ctx, reqCtx, { message: "use github" });

        expect(httpClient.authorizeCalls).toHaveLength(1);
        expect(httpClient.authorizeCalls[0]?.serverName).toBe("github");

        const text = (result.content?.[0] as { text: string }).text;
        expect(text).toContain("I can help once you authorize GitHub.");
        expect(text).toContain("github: https://idp.example.com/oauth/authorize?svc=github");
        expect(text).toMatch(/authoriz/i);

        expect(result.structuredContent).toMatchObject({
            kind: "chat_response",
            chat_id: "chat-1",
            auth_required: ["github"],
            auth_links: [
                {
                    server: "github",
                    authorize_url: "https://idp.example.com/oauth/authorize?svc=github",
                },
            ],
        });
    });

    it("fans out in parallel across multiple servers", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextSendResult = {
            response: "Need to auth two services.",
            chat_id: "chat-1",
            tenant_id: "t",
            agents_used: [],
            auth_required: ["github", "slack"],
        };
        const result = await runAskOrchid(ctx, reqCtx, { message: "multi" });

        expect(httpClient.authorizeCalls.map((c) => c.serverName).sort()).toEqual([
            "github",
            "slack",
        ]);

        const text = (result.content?.[0] as { text: string }).text;
        expect(text).toContain("github: https://idp.test/authorize?server=github");
        expect(text).toContain("slack: https://idp.test/authorize?server=slack");

        const links = (result.structuredContent as { auth_links: unknown[] }).auth_links;
        expect(links).toHaveLength(2);
    });

    it("degrades gracefully on partial authorize fetch failure", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextSendResult = {
            response: "Here's the plan.",
            chat_id: "chat-1",
            tenant_id: "t",
            agents_used: [],
            auth_required: ["github", "slack"],
        };
        httpClient.authorizeStubs.set("slack", new OrchidGatewayError("slack down"));

        const result = await runAskOrchid(ctx, reqCtx, { message: "hi" });

        expect(httpClient.authorizeCalls).toHaveLength(2);
        expect(result.isError).toBeFalsy();

        const text = (result.content?.[0] as { text: string }).text;
        // The original response is preserved.
        expect(text).toContain("Here's the plan.");
        // Successful fetch surfaces a URL.
        expect(text).toContain("github: https://idp.test/authorize?server=github");
        // Failed fetch surfaces a fallback message — the user is still
        // told which server needs auth, even though we couldn't get the URL.
        expect(text).toMatch(/slack: \(authorize URL temporarily unavailable/);

        const links = (result.structuredContent as { auth_links: { server: string }[] }).auth_links;
        expect(links).toHaveLength(2);
        const slackLink = links.find((l) => l.server === "slack");
        expect(slackLink).toBeDefined();
        expect(slackLink).not.toHaveProperty("authorize_url");
    });

    it("never throws from the tool when every authorize fetch fails", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextSendResult = {
            response: "Plan.",
            chat_id: "chat-1",
            tenant_id: "t",
            agents_used: [],
            auth_required: ["github", "slack"],
        };
        httpClient.authorizeStubs.set("github", new OrchidGatewayError("down"));
        httpClient.authorizeStubs.set("slack", new OrchidGatewayError("down"));

        const result = await runAskOrchid(ctx, reqCtx, { message: "hi" });

        expect(result.isError).toBeFalsy();
        const text = (result.content?.[0] as { text: string }).text;
        expect(text).toContain("Plan.");
        // Both servers fall back with a plain-text hint; URLs are absent.
        expect(text).not.toMatch(/https:\/\//);
        const links = (result.structuredContent as { auth_links: { server: string }[] }).auth_links;
        expect(links).toHaveLength(2);
    });

    it("does not enrich an interrupt result (auth_required only applies to ChatResponse)", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextSendResult = {
            chat_id: "chat-1",
            tenant_id: "t",
            status: "interrupted",
            approvals_needed: [{ tool: "t", args: {}, agent: "a", interrupt_id: "i" }],
        };
        await runAskOrchid(ctx, reqCtx, { message: "book it" });
        expect(httpClient.authorizeCalls).toHaveLength(0);
    });
});

describe("runAskOrchid — file attachments", () => {
    it("base64-decodes attached files and passes them to the upstream call", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextSendResult = {
            response: "ok",
            chat_id: "chat-1",
            tenant_id: "t",
            agents_used: [],
            auth_required: [],
        };
        const body = "hello from base64";
        const b64 = Buffer.from(body, "utf8").toString("base64");

        await runAskOrchid(ctx, reqCtx, {
            message: "see file",
            files: [{ filename: "note.txt", contentB64: b64, mimeType: "text/plain" }],
        });

        const sent = httpClient.sendCalls[0];
        expect(sent?.files).toHaveLength(1);
        expect(sent?.files[0]?.filename).toBe("note.txt");
        expect(sent?.files[0]?.mimeType).toBe("text/plain");
        expect(sent?.files[0]?.content.toString("utf8")).toBe(body);
    });
});

describe("runAskOrchid — HITL interrupt", () => {
    it("surfaces an interrupt as structured content and records a pending interrupt", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        httpClient.nextSendResult = {
            chat_id: "chat-int",
            tenant_id: "t",
            status: "interrupted",
            approvals_needed: [
                {
                    tool: "book_restaurant",
                    args: { party: 4 },
                    agent: "concierge",
                    interrupt_id: "i-1",
                },
            ],
        };

        const result = await runAskOrchid(ctx, reqCtx, { message: "book it" });

        expect(result.isError).toBeFalsy();
        expect(result.content?.[0]).toMatchObject({ type: "text" });
        const text = (result.content?.[0] as { text: string }).text;
        expect(text).toContain("book_restaurant");
        expect(text).toContain("orchid_resume_chat");
        expect(result.structuredContent).toMatchObject({
            kind: "interrupt",
            chat_id: "chat-int",
        });
        const pending = await sessionMap.popPendingInterrupt("sess-1", SHARED_SUBJECT);
        expect(pending).toBe("chat-int");
    });

    it("handles an interrupt with an empty approvals list gracefully", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.nextSendResult = {
            chat_id: "chat-int",
            tenant_id: "t",
            status: "interrupted",
            approvals_needed: [],
        };
        const result = await runAskOrchid(ctx, reqCtx, { message: "?" });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ kind: "interrupt" });
    });
});

describe("runAskOrchid — error mapping", () => {
    let loggerWarn: ReturnType<typeof vi.fn>;
    let loggerError: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        loggerWarn = vi.fn();
        loggerError = vi.fn();
    });

    function makeCtxWithErr(err: Error) {
        const { ctx, httpClient, sessionMap } = makeCtx();
        httpClient.nextSendResult = err;
        ctx.logger = {
            ...ctx.logger,
            warn: loggerWarn,
            error: loggerError,
        } as AppContext["logger"];
        return { ctx, httpClient, sessionMap };
    }

    it("maps OrchidUnauthorizedError to isError with a re-auth hint", async () => {
        const { ctx } = makeCtxWithErr(new OrchidUnauthorizedError("401"));
        const result = await runAskOrchid(ctx, reqCtx, { message: "q" });
        expect(result.isError).toBe(true);
        expect((result.content?.[0] as { text: string }).text).toMatch(/rejected the gateway/);
    });

    it("maps OrchidTimeoutError to isError with a timeout hint", async () => {
        const { ctx } = makeCtxWithErr(new OrchidTimeoutError("timeout"));
        const result = await runAskOrchid(ctx, reqCtx, { message: "q" });
        expect(result.isError).toBe(true);
        expect((result.content?.[0] as { text: string }).text).toMatch(/did not respond in time/);
    });

    it("maps OrchidServerError to isError including the upstream status", async () => {
        const { ctx } = makeCtxWithErr(new OrchidServerError("boom", 500, { detail: "kaboom" }));
        const result = await runAskOrchid(ctx, reqCtx, { message: "q" });
        expect(result.isError).toBe(true);
        const text = (result.content?.[0] as { text: string }).text;
        expect(text).toContain("500");
        expect(text).toContain("kaboom");
    });

    it("logs-and-wraps a generic gateway error", async () => {
        const { ctx } = makeCtxWithErr(new OrchidGatewayError("network down"));
        const result = await runAskOrchid(ctx, reqCtx, { message: "q" });
        expect(result.isError).toBe(true);
        expect(loggerWarn).toHaveBeenCalledTimes(1);
    });

    it("logs-and-wraps an unknown error", async () => {
        const { ctx } = makeCtxWithErr(new Error("surprise"));
        const result = await runAskOrchid(ctx, reqCtx, { message: "q" });
        expect(result.isError).toBe(true);
        expect(loggerError).toHaveBeenCalledTimes(1);
        expect((result.content?.[0] as { text: string }).text).toContain("surprise");
    });
});
