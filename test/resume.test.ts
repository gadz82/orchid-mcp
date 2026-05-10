import { describe, expect, it } from "vitest";

import type { AuthStrategy, MCPRequestContext, OrchidIdentity } from "../src/auth/base.js";
import { SHARED_SUBJECT } from "../src/auth/serviceAccount.js";
import type { AppContext } from "../src/context.js";
import { OrchidServerError, OrchidTimeoutError, OrchidUnauthorizedError } from "../src/errors.js";
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
import { runResumeChat } from "../src/tools/resume.js";

import { eventsNoop } from "./_helpers/stubEvents.js";

class StubAuthStrategy implements AuthStrategy {
    readonly mode = "service_account" as const;
    async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
        return { bearer: "tok", subject: SHARED_SUBJECT };
    }
}

interface ResumeCall {
    opts: CallOptions;
    chatId: string;
    approved: boolean;
}

class StubClient implements OrchidAPIClient {
    resumeCalls: ResumeCall[] = [];
    /** Successive responses to `resume()`; one per call. */
    resumeQueue: (SendResult | Error)[] = [];

    async createChat(_opts: CallOptions, _title?: string): Promise<ChatSession> {
        throw new Error("unused");
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
    async resume(opts: CallOptions, chatId: string, approved: boolean): Promise<SendResult> {
        this.resumeCalls.push({ opts, chatId, approved });
        const next = this.resumeQueue.shift();
        if (next === undefined) {
            throw new Error("test bug: resumeQueue drained");
        }
        if (next instanceof Error) {
            throw next;
        }
        return next;
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

describe("orchid_resume_chat — happy path", () => {
    it("pops the pending interrupt, calls resume(approved=true), returns chatResult", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        await sessionMap.setPendingInterrupt("sess-1", SHARED_SUBJECT, "chat-int");
        httpClient.resumeQueue.push({
            response: "Booked — see you at 7pm.",
            chat_id: "chat-int",
            tenant_id: "t",
            agents_used: ["concierge"],
            auth_required: [],
        });

        const result = await runResumeChat(ctx, extra, { approved: true });

        expect(result.isError).toBeFalsy();
        expect(httpClient.resumeCalls).toEqual([
            { opts: { bearer: "tok" }, chatId: "chat-int", approved: true },
        ]);
        expect((result.content?.[0] as { text: string }).text).toBe("Booked — see you at 7pm.");
        expect(result.structuredContent).toMatchObject({
            kind: "chat_response",
            chat_id: "chat-int",
        });
        expect(await sessionMap.popPendingInterrupt("sess-1", SHARED_SUBJECT)).toBeNull();
    });

    it("forwards approved=false to the upstream resume call", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        await sessionMap.setPendingInterrupt("sess-1", SHARED_SUBJECT, "chat-int");
        httpClient.resumeQueue.push({
            response: "Skipped.",
            chat_id: "chat-int",
            tenant_id: "t",
            agents_used: [],
            auth_required: [],
        });

        await runResumeChat(ctx, extra, { approved: false });

        expect(httpClient.resumeCalls[0]?.approved).toBe(false);
    });
});

describe("orchid_resume_chat — no pending interrupt", () => {
    it("returns isError without touching the upstream client", async () => {
        const { ctx, httpClient } = makeCtx();
        const result = await runResumeChat(ctx, extra, { approved: true });
        expect(result.isError).toBe(true);
        expect(httpClient.resumeCalls).toHaveLength(0);
        expect((result.content?.[0] as { text: string }).text).toMatch(
            /No pending Orchid interrupt/,
        );
    });

    it("distinguishes per subject — another session's pending does not leak in", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        await sessionMap.setPendingInterrupt("sess-other", SHARED_SUBJECT, "chat-other");
        const result = await runResumeChat(ctx, extra, { approved: true });
        expect(result.isError).toBe(true);
        expect(httpClient.resumeCalls).toHaveLength(0);
        // the other session's pending is still there
        expect(await sessionMap.popPendingInterrupt("sess-other", SHARED_SUBJECT)).toBe(
            "chat-other",
        );
    });
});

describe("orchid_resume_chat — chained interrupt", () => {
    it("re-records the pending interrupt when the graph pauses again", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        await sessionMap.setPendingInterrupt("sess-1", SHARED_SUBJECT, "chat-1");
        httpClient.resumeQueue.push({
            chat_id: "chat-1",
            tenant_id: "t",
            status: "interrupted",
            approvals_needed: [
                { tool: "charge_card", args: {}, agent: "billing", interrupt_id: "i-2" },
            ],
        });

        const result = await runResumeChat(ctx, extra, { approved: true });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
            kind: "interrupt",
            chat_id: "chat-1",
        });
        expect(await sessionMap.popPendingInterrupt("sess-1", SHARED_SUBJECT)).toBe("chat-1");
    });
});

describe("orchid_resume_chat — error handling restores the pending", () => {
    async function runWithError(err: Error) {
        const { ctx, httpClient, sessionMap } = makeCtx();
        await sessionMap.setPendingInterrupt("sess-1", SHARED_SUBJECT, "chat-1");
        httpClient.resumeQueue.push(err);
        const result = await runResumeChat(ctx, extra, { approved: true });
        return { ctx, httpClient, sessionMap, result };
    }

    it("restores the pending on a transient OrchidServerError (500)", async () => {
        const { sessionMap, result } = await runWithError(
            new OrchidServerError("boom", 500, "eek"),
        );
        expect(result.isError).toBe(true);
        expect(await sessionMap.popPendingInterrupt("sess-1", SHARED_SUBJECT)).toBe("chat-1");
    });

    it("restores the pending on OrchidUnauthorizedError", async () => {
        const { sessionMap, result } = await runWithError(new OrchidUnauthorizedError("401"));
        expect(result.isError).toBe(true);
        expect(await sessionMap.popPendingInterrupt("sess-1", SHARED_SUBJECT)).toBe("chat-1");
    });

    it("restores the pending on OrchidTimeoutError", async () => {
        const { sessionMap, result } = await runWithError(new OrchidTimeoutError("slow"));
        expect(result.isError).toBe(true);
        expect(await sessionMap.popPendingInterrupt("sess-1", SHARED_SUBJECT)).toBe("chat-1");
    });

    it("maps the 400 'no checkpointer' case as a regular server error, pending restored", async () => {
        const { sessionMap, result } = await runWithError(
            new OrchidServerError("bad request", 400, {
                detail: "Cannot resume: no checkpointer configured.",
            }),
        );
        expect(result.isError).toBe(true);
        expect((result.content?.[0] as { text: string }).text).toMatch(/400/);
        expect(await sessionMap.popPendingInterrupt("sess-1", SHARED_SUBJECT)).toBe("chat-1");
    });

    it("lets the user retry after a restored-from-error pending", async () => {
        const { ctx, httpClient, sessionMap } = makeCtx();
        await sessionMap.setPendingInterrupt("sess-1", SHARED_SUBJECT, "chat-1");
        httpClient.resumeQueue.push(new OrchidServerError("boom", 500, "transient"));
        httpClient.resumeQueue.push({
            response: "Done second time.",
            chat_id: "chat-1",
            tenant_id: "t",
            agents_used: [],
            auth_required: [],
        });

        const first = await runResumeChat(ctx, extra, { approved: true });
        expect(first.isError).toBe(true);

        const second = await runResumeChat(ctx, extra, { approved: true });
        expect(second.isError).toBeFalsy();
        expect((second.content?.[0] as { text: string }).text).toBe("Done second time.");
        expect(httpClient.resumeCalls).toHaveLength(2);
    });
});
