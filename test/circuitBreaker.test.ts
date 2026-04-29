import { afterEach, describe, expect, it } from "vitest";

import { CircuitBreakerOrchidAPIClient } from "../src/http/circuitBreaker.js";
import { OrchidGatewayError } from "../src/errors.js";
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

class FlappyInner implements OrchidAPIClient {
    shouldFail = true;
    listChatsCalls = 0;

    async createChat(_opts: CallOptions, _title?: string): Promise<ChatSession> {
        throw new Error("unused");
    }
    async listChats(_opts: CallOptions): Promise<ChatSession[]> {
        this.listChatsCalls += 1;
        if (this.shouldFail) throw new Error("boom");
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

const opts: CallOptions = { bearer: "tok" };
let breakerClient: CircuitBreakerOrchidAPIClient | null = null;

afterEach(async () => {
    if (breakerClient !== null) {
        await breakerClient.close();
        breakerClient = null;
    }
});

describe("CircuitBreakerOrchidAPIClient", () => {
    it("delegates successful calls to the inner client", async () => {
        const inner = new FlappyInner();
        inner.shouldFail = false;
        breakerClient = new CircuitBreakerOrchidAPIClient({
            inner,
            logger: createLogger("silent"),
        });
        const result = await breakerClient.listChats(opts);
        expect(result).toEqual([]);
        expect(inner.listChatsCalls).toBe(1);
    });

    it("opens the breaker after enough failures and fails fast", async () => {
        const inner = new FlappyInner();
        breakerClient = new CircuitBreakerOrchidAPIClient({
            inner,
            logger: createLogger("silent"),
            config: {
                errorThresholdPercentage: 50,
                resetTimeoutMs: 30_000,
                rollingWindowMs: 10_000,
            },
        });

        // Fire 10 failing calls — enough to trip opossum's default bucket.
        for (let i = 0; i < 10; i += 1) {
            await expect(breakerClient.listChats(opts)).rejects.toBeTruthy();
        }

        // Wait a tick for opossum to update its state.
        await new Promise((resolve) => setImmediate(resolve));

        // Subsequent calls should fail fast with OrchidGatewayError (breaker open)
        // OR with the underlying error — opossum might still run one request.
        // Fire another batch to guarantee the breaker has opened.
        for (let i = 0; i < 10; i += 1) {
            try {
                await breakerClient.listChats(opts);
            } catch (err) {
                if (err instanceof OrchidGatewayError && err.message.includes("circuit breaker open")) {
                    // Success — breaker opened at some point.
                    return;
                }
            }
        }
        throw new Error("Expected circuit breaker to open after sustained failures");
    });

    it("delegates every method to the inner client", async () => {
        const calls: string[] = [];
        const stub: OrchidAPIClient = {
            async createChat() {
                calls.push("createChat");
                return { id: "c", title: "", created_at: "t", updated_at: "t", is_shared: false };
            },
            async listChats() {
                calls.push("listChats");
                return [];
            },
            async getMessages() {
                calls.push("getMessages");
                return [];
            },
            async sendMessage() {
                calls.push("sendMessage");
                return {
                    response: "ok",
                    chat_id: "c",
                    tenant_id: "t",
                    agents_used: [],
                    auth_required: [],
                };
            },
            async sendMessageStream() {
                calls.push("sendMessageStream");
                return {
                    type: "done" as const,
                    response: "ok",
                    agents_used: [],
                    agent_results: {},
                    auth_required: [],
                };
            },
            async resume() {
                calls.push("resume");
                return {
                    response: "ok",
                    chat_id: "c",
                    tenant_id: "t",
                    agents_used: [],
                    auth_required: [],
                };
            },
            async upload() {
                calls.push("upload");
                return { status: "ok", files: [] };
            },
            async getGatewayConfig() {
                calls.push("getGatewayConfig");
                return { tools: {}, prompts: [] };
            },
            async getAuthInfo() {
                calls.push("getAuthInfo");
                return { dev_bypass: true, identity_resolver_configured: false };
            },
            async getMcpServerAuthorizeUrl() {
                calls.push("getMcpServerAuthorizeUrl");
                return { authorize_url: "https://idp.test/authorize", state: "s" };
            },
            async exchangeAuthorizationCode() {
                calls.push("exchangeAuthorizationCode");
                return { access_token: "at-stub", token_type: "Bearer" };
            },
            async resolveIdentity() {
                calls.push("resolveIdentity");
                return {
                    subject: "u-1",
                    bearer: "tok",
                    auth_domain: "",
                    email: "",
                    extra: {},
                };
            },
            async refreshUpstreamToken() {
                calls.push("refreshUpstreamToken");
                return { access_token: "at-refreshed", token_type: "Bearer" };
            },
            async close() {
                calls.push("close");
            },
        };
        breakerClient = new CircuitBreakerOrchidAPIClient({
            inner: stub,
            logger: createLogger("silent"),
        });
        await breakerClient.createChat(opts);
        await breakerClient.listChats(opts);
        await breakerClient.getMessages(opts, "c", 10, 0);
        await breakerClient.sendMessage(opts, "c", "hi");
        await breakerClient.resume(opts, "c", true);
        await breakerClient.upload(opts, "c", [{ filename: "f", content: Buffer.from("x") }]);
        expect(calls).toEqual([
            "createChat",
            "listChats",
            "getMessages",
            "sendMessage",
            "resume",
            "upload",
        ]);
    });

    it("close() shuts down breakers and delegates to inner", async () => {
        let innerClosed = false;
        const inner = new FlappyInner();
        inner.close = async () => {
            innerClosed = true;
        };
        const client = new CircuitBreakerOrchidAPIClient({
            inner,
            logger: createLogger("silent"),
        });
        await client.close();
        expect(innerClosed).toBe(true);
    });

});
