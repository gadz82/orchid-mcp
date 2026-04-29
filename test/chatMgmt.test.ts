import { describe, expect, it } from "vitest";

import type { AuthStrategy, MCPRequestContext, OrchidIdentity } from "../src/auth/base.js";
import { SHARED_SUBJECT } from "../src/auth/serviceAccount.js";
import type { AppContext } from "../src/context.js";
import { OrchidServerError, OrchidUnauthorizedError } from "../src/errors.js";
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
import { MemorySessionMap } from "../src/sessions/memory.js";
import { runListChats, runNewChat, runSwitchChat } from "../src/tools/chatMgmt.js";

class StubAuthStrategy implements AuthStrategy {
    readonly mode = "service_account" as const;
    identity: OrchidIdentity = { bearer: "tok", subject: SHARED_SUBJECT };
    async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
        return this.identity;
    }
}

class StubClient implements OrchidAPIClient {
    createChatResult: ChatSession = {
        id: "chat-new",
        title: "New chat",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        is_shared: false,
    };
    createChatCalls: { title?: string }[] = [];
    listChatsResult: ChatSession[] = [];
    getMessagesResult: ChatMessage[] | Error = [];
    getMessagesCalls: { chatId: string; limit: number; offset: number }[] = [];

    async createChat(_opts: CallOptions, title?: string): Promise<ChatSession> {
        const call: { title?: string } = {};
        if (title !== undefined) call.title = title;
        this.createChatCalls.push(call);
        return this.createChatResult;
    }
    async listChats(_opts: CallOptions): Promise<ChatSession[]> {
        return this.listChatsResult;
    }
    async getMessages(
        _opts: CallOptions,
        chatId: string,
        limit = 50,
        offset = 0,
    ): Promise<ChatMessage[]> {
        this.getMessagesCalls.push({ chatId, limit, offset });
        if (this.getMessagesResult instanceof Error) {
            throw this.getMessagesResult;
        }
        return this.getMessagesResult;
    }
    async sendMessage(
        _opts: CallOptions,
        _chatId: string,
        _message: string,
        _files?: FileAttachment[],
    ): Promise<SendResult> {
        throw new Error("unused");
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

function makeCtx() {
    const httpClient = new StubClient();
    const sessionMap = new MemorySessionMap({ ttlSeconds: 60 });
    const ctx: AppContext = {
        settings: {} as AppContext["settings"],
        logger: createLogger("silent"),
        httpClient,
        sessionMap,
        authStrategy: new StubAuthStrategy(),
        rateLimiter: new NoopRateLimiter(),
    };
    return { ctx, httpClient, sessionMap };
}

const extra = { sessionId: "sess-1", requestInfo: { headers: {} } };

/* ── orchid_new_chat ─────────────────────────────────────────── */

describe("orchid_new_chat", () => {
    it("creates a chat, binds it to the session, and returns structured content", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        httpClient.createChatResult = {
            id: "chat-abc",
            title: "Planning",
            created_at: "t",
            updated_at: "t",
            is_shared: false,
        };

        const result = await runNewChat(ctx, extra, { title: "Planning" });

        expect(result.isError).toBeFalsy();
        expect(httpClient.createChatCalls).toEqual([{ title: "Planning" }]);
        expect(await sessionMap.getChatId("sess-1", SHARED_SUBJECT)).toBe("chat-abc");
        expect(result.structuredContent).toEqual({
            kind: "chat_created",
            chat_id: "chat-abc",
            title: "Planning",
        });
    });

    it("rebinds the session — a new chat overrides the previous binding", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        await sessionMap.setChatId("sess-1", SHARED_SUBJECT, "chat-old");

        httpClient.createChatResult = {
            id: "chat-fresh",
            title: "",
            created_at: "t",
            updated_at: "t",
            is_shared: false,
        };
        await runNewChat(ctx, extra, {});

        expect(await sessionMap.getChatId("sess-1", SHARED_SUBJECT)).toBe("chat-fresh");
    });

    it("clears any pending interrupt carried over from a prior chat", async () => {
        const { ctx, sessionMap } = makeCtx();
        await sessionMap.setPendingInterrupt("sess-1", SHARED_SUBJECT, "chat-old");
        await runNewChat(ctx, extra, {});
        expect(await sessionMap.popPendingInterrupt("sess-1", SHARED_SUBJECT)).toBeNull();
    });

    it("maps an upstream 401 to OrchidUnauthorizedError → isError", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.createChat = async () => {
            throw new OrchidUnauthorizedError("nope");
        };
        const result = await runNewChat(ctx, extra, {});
        expect(result.isError).toBe(true);
    });
});

/* ── orchid_list_chats ───────────────────────────────────────── */

describe("orchid_list_chats", () => {
    it("returns an empty-state message when the user has no chats", async () => {
        const { ctx } = makeCtx();
        const result = await runListChats(ctx, extra);
        expect(result.isError).toBeFalsy();
        expect((result.content?.[0] as { text: string }).text).toMatch(/no Orchid chats/);
        expect(result.structuredContent).toMatchObject({ kind: "chat_list", chats: [] });
    });

    it("returns a structured list of chats with the required fields", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.listChatsResult = [
            {
                id: "c1",
                title: "One",
                created_at: "2025-04-01",
                updated_at: "2025-04-02",
                is_shared: false,
            },
            {
                id: "c2",
                title: "Two",
                created_at: "2025-04-03",
                updated_at: "2025-04-04",
                is_shared: true,
            },
        ];
        const result = await runListChats(ctx, extra);
        expect(result.structuredContent).toMatchObject({
            kind: "chat_list",
            chats: [
                {
                    chat_id: "c1",
                    title: "One",
                    created_at: "2025-04-01",
                    updated_at: "2025-04-02",
                    is_shared: false,
                },
                {
                    chat_id: "c2",
                    title: "Two",
                    created_at: "2025-04-03",
                    updated_at: "2025-04-04",
                    is_shared: true,
                },
            ],
        });
    });

    it("surfaces upstream errors via the shared error mapper", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.listChats = async () => {
            throw new OrchidServerError("boom", 500, { detail: "db down" });
        };
        const result = await runListChats(ctx, extra);
        expect(result.isError).toBe(true);
        expect((result.content?.[0] as { text: string }).text).toMatch(/500/);
    });
});

/* ── orchid_switch_chat ──────────────────────────────────────── */

describe("orchid_switch_chat", () => {
    it("probes ownership with limit=1/offset=0 and binds on success", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        const result = await runSwitchChat(ctx, extra, { chatId: "chat-xyz" });
        expect(result.isError).toBeFalsy();
        expect(httpClient.getMessagesCalls).toEqual([{ chatId: "chat-xyz", limit: 1, offset: 0 }]);
        expect(await sessionMap.getChatId("sess-1", SHARED_SUBJECT)).toBe("chat-xyz");
        expect(result.structuredContent).toMatchObject({
            kind: "chat_switched",
            chat_id: "chat-xyz",
        });
    });

    it("rejects a 404 with isError and leaves the session binding untouched", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        await sessionMap.setChatId("sess-1", SHARED_SUBJECT, "chat-current");
        httpClient.getMessagesResult = new OrchidServerError("not found", 404, {
            detail: "Chat not found",
        });

        const result = await runSwitchChat(ctx, extra, { chatId: "chat-missing" });

        expect(result.isError).toBe(true);
        expect((result.content?.[0] as { text: string }).text).toMatch(/not found/);
        expect(await sessionMap.getChatId("sess-1", SHARED_SUBJECT)).toBe("chat-current");
    });

    it("propagates non-404 server errors via the shared mapper", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.getMessagesResult = new OrchidServerError("boom", 500, "kaboom");
        const result = await runSwitchChat(ctx, extra, { chatId: "chat-x" });
        expect(result.isError).toBe(true);
        expect((result.content?.[0] as { text: string }).text).toMatch(/500/);
    });

    it("maps 401 → isError via OrchidUnauthorizedError", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.getMessagesResult = new OrchidUnauthorizedError("no");
        const result = await runSwitchChat(ctx, extra, { chatId: "chat-x" });
        expect(result.isError).toBe(true);
    });

    it("clears a pending interrupt from the prior chat when switching", async () => {
        const { ctx, sessionMap } = makeCtx();
        await sessionMap.setPendingInterrupt("sess-1", SHARED_SUBJECT, "chat-old");
        await runSwitchChat(ctx, extra, { chatId: "chat-new" });
        expect(await sessionMap.popPendingInterrupt("sess-1", SHARED_SUBJECT)).toBeNull();
    });
});
