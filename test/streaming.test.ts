import { describe, expect, it } from "vitest";

import type { AuthStrategy, MCPRequestContext, OrchidIdentity } from "../src/auth/base.js";
import { SHARED_SUBJECT } from "../src/auth/serviceAccount.js";
import type { AppContext } from "../src/context.js";
import type {
    CallOptions,
    ChatMessage,
    ChatSession,
    FileAttachment,
    OrchidAPIClient,
    SendResult,
    StreamDoneEvent,
    StreamEvent,
    StreamHandlers,
    UploadResponse,
} from "../src/http/orchidClient.js";
import { createLogger } from "../src/observability/logger.js";
import { NoopRateLimiter } from "../src/rateLimit.js";
import { MemorySessionMap } from "../src/sessions/memory.js";
import { registerAskOrchidTool, runAskOrchid } from "../src/tools/askOrchid.js";
import type { Settings } from "../src/settings.js";

import { eventsNoop } from "./_helpers/stubEvents.js";

void registerAskOrchidTool;

class StubAuthStrategy implements AuthStrategy {
    readonly mode = "service_account" as const;
    async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
        return { bearer: "tok", subject: SHARED_SUBJECT };
    }
}

class StreamingStubClient implements OrchidAPIClient {
    chatResponse: ChatSession = {
        id: "chat-1",
        title: "",
        created_at: "t",
        updated_at: "t",
        is_shared: false,
    };
    /** Pre-programmed events fed to the onEvent callback in order. */
    events: StreamEvent[] = [];
    /** If set, throw this error instead of driving events. */
    streamError: Error | null = null;
    streamCalls = 0;
    sendMessageCalls = 0;

    async createChat(_opts: CallOptions, _title?: string): Promise<ChatSession> {
        return this.chatResponse;
    }
    async listChats(): Promise<ChatSession[]> {
        return [];
    }
    async getMessages(): Promise<ChatMessage[]> {
        return [];
    }
    async sendMessage(): Promise<SendResult> {
        this.sendMessageCalls += 1;
        return {
            response: "non-stream answer",
            chat_id: "chat-1",
            tenant_id: "t",
            agents_used: [],
            auth_required: [],
        };
    }
    async sendMessageStream(
        _opts: CallOptions,
        _chatId: string,
        _message: string,
        _files: FileAttachment[] | undefined,
        handlers: StreamHandlers,
    ): Promise<StreamDoneEvent> {
        this.streamCalls += 1;
        if (this.streamError !== null) {
            throw this.streamError;
        }
        let done: StreamDoneEvent | null = null;
        for (const ev of this.events) {
            await handlers.onEvent(ev);
            if (ev.type === "done") done = ev;
        }
        if (done === null) {
            throw new Error("test stub: events must include a done event");
        }
        return done;
    }
    async resume(): Promise<SendResult> {
        throw new Error("unused");
    }
    async upload(): Promise<UploadResponse> {
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
    emitSignal = eventsNoop().emitSignal;
    getRun = eventsNoop().getRun;
    listRuns = eventsNoop().listRuns;
    listRunsForSignal = eventsNoop().listRunsForSignal;
}

function makeCtx(streamingEnabled: boolean) {
    const httpClient = new StreamingStubClient();
    const sessionMap = new MemorySessionMap({ ttlSeconds: 60 });
    const ctx: AppContext = {
        settings: {
            streamingEnabled,
            streamingProgressIntervalMs: 0, // no coalescing in tests
        } as unknown as Settings,
        logger: createLogger("silent"),
        httpClient,
        sessionMap,
        authStrategy: new StubAuthStrategy(),
        rateLimiter: new NoopRateLimiter(),
    };
    return { ctx, httpClient, sessionMap };
}

const reqCtx: MCPRequestContext = { mcpSessionId: "sess-1", headers: {} };

describe("orchid_ask — streaming path", () => {
    it("uses sendMessageStream when streaming is enabled and a progressToken is supplied", async () => {
        const { ctx, httpClient } = makeCtx(true);
        httpClient.events = [
            { type: "token", content: "Hello " },
            { type: "token", content: "world." },
            {
                type: "done",
                response: "Hello world.",
                agents_used: ["talker"],
                agent_results: {},
                auth_required: [],
            },
        ];
        const sentNotifications: { method: string; params: Record<string, unknown> }[] = [];
        const extra = {
            sessionId: "sess-1",
            requestInfo: { headers: {} },
            _meta: { progressToken: "tok-123" },
            sendNotification: async (n: {
                method: string;
                params: Record<string, unknown>;
            }) => {
                sentNotifications.push(n);
            },
        };

        const result = await runAskOrchid(
            ctx,
            reqCtx,
            { message: "hi" },
            extra as unknown as Parameters<typeof runAskOrchid>[3],
        );

        expect(httpClient.streamCalls).toBe(1);
        expect(httpClient.sendMessageCalls).toBe(0);
        expect(result.isError).toBeFalsy();
        expect((result.content?.[0] as { text: string }).text).toBe("Hello world.");
        expect(result.structuredContent).toMatchObject({
            kind: "chat_response",
            agents_used: ["talker"],
        });
        expect(sentNotifications.length).toBeGreaterThan(0);
        const progressValues = sentNotifications.map((n) => n.params.progress);
        expect(progressValues[0]).toBe(1);
        expect(sentNotifications.every((n) => n.params.progressToken === "tok-123")).toBe(
            true,
        );
    });

    it("coalesces token bursts via streamingProgressIntervalMs", async () => {
        const { ctx, httpClient } = makeCtx(true);
        ctx.settings = {
            ...ctx.settings,
            streamingProgressIntervalMs: 10_000,
        } as Settings;
        httpClient.events = [
            { type: "token", content: "a" },
            { type: "token", content: "b" },
            { type: "token", content: "c" },
            {
                type: "done",
                response: "abc",
                agents_used: [],
                agent_results: {},
                auth_required: [],
            },
        ];
        const sent: unknown[] = [];
        const extra = {
            sessionId: "sess-1",
            requestInfo: { headers: {} },
            _meta: { progressToken: "tok" },
            sendNotification: async (n: unknown) => {
                sent.push(n);
            },
        };
        await runAskOrchid(
            ctx,
            reqCtx,
            { message: "hi" },
            extra as unknown as Parameters<typeof runAskOrchid>[3],
        );
        // With a 10s interval, we'd expect only the forced final notification
        // (plus possibly the very first one since lastSent starts at 0).
        expect(sent.length).toBeLessThanOrEqual(2);
    });

    it("emits a progress notification per status event (force=true)", async () => {
        const { ctx, httpClient } = makeCtx(true);
        httpClient.events = [
            { type: "status", agent: "basketball", status: "started" },
            { type: "status", agent: "basketball", status: "done", preview: "…" },
            {
                type: "done",
                response: "final",
                agents_used: ["basketball"],
                agent_results: {},
                auth_required: [],
            },
        ];
        const sent: { method: string; params: { message?: string } }[] = [];
        const extra = {
            sessionId: "sess-1",
            requestInfo: { headers: {} },
            _meta: { progressToken: 42 },
            sendNotification: async (n: { method: string; params: { message?: string } }) => {
                sent.push(n);
            },
        };
        await runAskOrchid(
            ctx,
            reqCtx,
            { message: "hi" },
            extra as unknown as Parameters<typeof runAskOrchid>[3],
        );
        expect(sent.length).toBeGreaterThanOrEqual(2);
        expect(sent[0]?.params.message).toContain("basketball");
    });

    it("falls back to sendMessage when streaming is disabled", async () => {
        const { ctx, httpClient } = makeCtx(false);
        httpClient.events = []; // unused
        const extra = {
            sessionId: "sess-1",
            requestInfo: { headers: {} },
            _meta: { progressToken: "tok" },
            sendNotification: async () => {
                /* noop */
            },
        };
        await runAskOrchid(
            ctx,
            reqCtx,
            { message: "hi" },
            extra as unknown as Parameters<typeof runAskOrchid>[3],
        );
        expect(httpClient.streamCalls).toBe(0);
        expect(httpClient.sendMessageCalls).toBe(1);
    });

    it("falls back to sendMessage when the client did not pass a progressToken", async () => {
        const { ctx, httpClient } = makeCtx(true);
        const extra = {
            sessionId: "sess-1",
            requestInfo: { headers: {} },
        };
        await runAskOrchid(
            ctx,
            reqCtx,
            { message: "hi" },
            extra as unknown as Parameters<typeof runAskOrchid>[3],
        );
        expect(httpClient.streamCalls).toBe(0);
        expect(httpClient.sendMessageCalls).toBe(1);
    });

    it("maps an upstream streaming error into an isError result", async () => {
        const { ctx, httpClient } = makeCtx(true);
        httpClient.streamError = new Error("connection lost");
        const extra = {
            sessionId: "sess-1",
            requestInfo: { headers: {} },
            _meta: { progressToken: "tok" },
            sendNotification: async () => {
                /* noop */
            },
        };
        const result = await runAskOrchid(
            ctx,
            reqCtx,
            { message: "hi" },
            extra as unknown as Parameters<typeof runAskOrchid>[3],
        );
        expect(result.isError).toBe(true);
    });

    it("enriches the streaming result with authorize URLs when auth_required is non-empty", async () => {
        const { ctx, httpClient } = makeCtx(true);
        httpClient.events = [
            { type: "token", content: "need " },
            { type: "token", content: "auth." },
            {
                type: "done",
                response: "need auth.",
                agents_used: [],
                agent_results: {},
                auth_required: ["github"],
            },
        ];
        const extra = {
            sessionId: "sess-1",
            requestInfo: { headers: {} },
            _meta: { progressToken: "tok" },
            sendNotification: async () => {
                /* noop */
            },
        };
        const result = await runAskOrchid(
            ctx,
            reqCtx,
            { message: "hi" },
            extra as unknown as Parameters<typeof runAskOrchid>[3],
        );
        const text = (result.content?.[0] as { text: string }).text;
        expect(text).toContain("need auth.");
        expect(text).toContain("github: https://idp.test/authorize");
        expect(result.structuredContent).toMatchObject({
            auth_required: ["github"],
            auth_links: [{ server: "github", authorize_url: "https://idp.test/authorize" }],
        });
    });

    it("ignores sendNotification failures (client gone mid-stream)", async () => {
        const { ctx, httpClient } = makeCtx(true);
        httpClient.events = [
            { type: "token", content: "a" },
            {
                type: "done",
                response: "a",
                agents_used: [],
                agent_results: {},
                auth_required: [],
            },
        ];
        const extra = {
            sessionId: "sess-1",
            requestInfo: { headers: {} },
            _meta: { progressToken: "tok" },
            sendNotification: async () => {
                throw new Error("client disconnected");
            },
        };
        const result = await runAskOrchid(
            ctx,
            reqCtx,
            { message: "hi" },
            extra as unknown as Parameters<typeof runAskOrchid>[3],
        );
        // No throw — the upstream run completed despite notification failures.
        expect(result.isError).toBeFalsy();
        expect(httpClient.streamCalls).toBe(1);
    });
});
