import { describe, expect, it } from "vitest";

import { eventsNoop } from "./_helpers/stubEvents.js";

import type { AuthStrategy, MCPRequestContext, OrchidIdentity } from "../src/auth/base.js";
import { SHARED_SUBJECT } from "../src/auth/serviceAccount.js";
import type { AppContext } from "../src/context.js";
import { OrchidServerError } from "../src/errors.js";
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
import { runUploadFile } from "../src/tools/upload.js";

class StubAuthStrategy implements AuthStrategy {
    readonly mode = "service_account" as const;
    async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
        return { bearer: "tok", subject: SHARED_SUBJECT };
    }
}

class StubClient implements OrchidAPIClient {
    createChatResponse: ChatSession = {
        id: "chat-new",
        title: "",
        created_at: "t",
        updated_at: "t",
        is_shared: false,
    };
    uploadResponse: UploadResponse | Error = {
        status: "ok",
        files: [{ filename: "note.txt", chunks_indexed: 3 }],
    };
    createChatCalls = 0;
    uploadCalls: { chatId: string; files: FileAttachment[] }[] = [];

    async createChat(_opts: CallOptions, _title?: string): Promise<ChatSession> {
        this.createChatCalls += 1;
        return this.createChatResponse;
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
        chatId: string,
        files: FileAttachment[],
    ): Promise<UploadResponse> {
        this.uploadCalls.push({ chatId, files });
        if (this.uploadResponse instanceof Error) {
            throw this.uploadResponse;
        }
        return this.uploadResponse;
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

describe("orchid_upload_file", () => {
    it("base64-decodes the payload and forwards the filename + mimeType", async () => {
        const { ctx, httpClient } = makeCtx();
        await httpClient.createChat; // silence unused
        const body = "hello world";
        const b64 = Buffer.from(body, "utf8").toString("base64");
        const result = await runUploadFile(ctx, extra, {
            filename: "greeting.txt",
            contentB64: b64,
            mimeType: "text/plain",
        });
        expect(result.isError).toBeFalsy();
        expect(httpClient.uploadCalls).toHaveLength(1);
        const sent = httpClient.uploadCalls[0];
        expect(sent?.files).toHaveLength(1);
        expect(sent?.files[0]?.filename).toBe("greeting.txt");
        expect(sent?.files[0]?.mimeType).toBe("text/plain");
        expect(sent?.files[0]?.content.toString("utf8")).toBe(body);
    });

    it("auto-creates a chat on first upload when none is bound", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        httpClient.createChatResponse = {
            id: "chat-auto",
            title: "",
            created_at: "t",
            updated_at: "t",
            is_shared: false,
        };
        await runUploadFile(ctx, extra, {
            filename: "note.txt",
            contentB64: Buffer.from("hi").toString("base64"),
        });
        expect(httpClient.createChatCalls).toBe(1);
        expect(await sessionMap.getChatId("sess-1", SHARED_SUBJECT)).toBe("chat-auto");
        expect(httpClient.uploadCalls[0]?.chatId).toBe("chat-auto");
    });

    it("uses an already-bound chat instead of creating a new one", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        await sessionMap.setChatId("sess-1", SHARED_SUBJECT, "chat-existing");
        await runUploadFile(ctx, extra, {
            filename: "f.txt",
            contentB64: Buffer.from("x").toString("base64"),
        });
        expect(httpClient.createChatCalls).toBe(0);
        expect(httpClient.uploadCalls[0]?.chatId).toBe("chat-existing");
    });

    it("surfaces a per-file error from the upstream response as isError", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.uploadResponse = {
            status: "ok",
            files: [{ filename: "corrupt.pdf", error: "Processing failed" }],
        };
        const result = await runUploadFile(ctx, extra, {
            filename: "corrupt.pdf",
            contentB64: Buffer.from("%PDF").toString("base64"),
        });
        expect(result.isError).toBe(true);
        expect((result.content?.[0] as { text: string }).text).toMatch(/Processing failed/);
    });

    it("returns chunks_indexed in structured content on success", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.uploadResponse = {
            status: "ok",
            files: [{ filename: "x.md", chunks_indexed: 7 }],
        };
        const result = await runUploadFile(ctx, extra, {
            filename: "x.md",
            contentB64: Buffer.from("hi").toString("base64"),
        });
        expect(result.structuredContent).toMatchObject({
            kind: "file_uploaded",
            filename: "x.md",
            chunks_indexed: 7,
        });
    });

    it("propagates orchid-api transport errors through the shared helper", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.uploadResponse = new OrchidServerError("gone", 503, "service unavailable");
        const result = await runUploadFile(ctx, extra, {
            filename: "a.txt",
            contentB64: Buffer.from("x").toString("base64"),
        });
        expect(result.isError).toBe(true);
        expect((result.content?.[0] as { text: string }).text).toMatch(/503/);
    });
});
