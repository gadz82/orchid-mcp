/**
 * Apply-config integration test: a real :class:`McpServer`, the real
 * `registerTools` registration, and :func:`applyGatewayConfig` over
 * the top. Drives the server through the SDK's ``StreamableHTTP``
 * client transport so ``tools/list`` + ``prompts/list`` + ``prompts/get``
 * all exercise the actual MCP protocol.
 */

import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthStrategy, MCPRequestContext, OrchidIdentity } from "../src/auth/base.js";
import { SHARED_SUBJECT } from "../src/auth/serviceAccount.js";
import type { AppContext } from "../src/context.js";
import type {
    CallOptions,
    ChatMessage,
    ChatSession,
    FileAttachment,
    GatewayConfig,
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

class StubAuth implements AuthStrategy {
    readonly mode = "service_account" as const;
    async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
        return { bearer: "tok", subject: SHARED_SUBJECT };
    }
}

class StubClient implements OrchidAPIClient {
    nextConfig: GatewayConfig = { tools: {}, prompts: [] };
    configFetchCalls = 0;

    async createChat(_o: CallOptions, _t?: string): Promise<ChatSession> {
        return { id: "c", title: "", created_at: "t", updated_at: "t", is_shared: false };
    }
    async listChats(): Promise<ChatSession[]> {
        return [];
    }
    async getMessages(): Promise<ChatMessage[]> {
        return [];
    }
    async sendMessage(): Promise<SendResult> {
        return {
            response: "ok",
            chat_id: "c",
            tenant_id: "t",
            agents_used: [],
            auth_required: [],
        };
    }
    async sendMessageStream(
        _o: CallOptions,
        _c: string,
        _m: string,
        _f: FileAttachment[] | undefined,
        _h: StreamHandlers,
    ): Promise<StreamDoneEvent> {
        throw new Error("unused");
    }
    async resume(): Promise<SendResult> {
        throw new Error("unused");
    }
    async upload(): Promise<UploadResponse> {
        throw new Error("unused");
    }
    async getGatewayConfig(_o: CallOptions): Promise<GatewayConfig> {
        this.configFetchCalls += 1;
        return this.nextConfig;
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

async function startGateway(stub: StubClient): Promise<{
    url: string;
    built: BuiltServer;
    stop: () => Promise<void>;
}> {
    const ctx: AppContext = {
        settings: {} as AppContext["settings"],
        logger: createLogger("silent"),
        httpClient: stub,
        sessionMap: new MemorySessionMap({ ttlSeconds: 60 }),
        authStrategy: new StubAuth(),
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

describe("MCP gateway config — applied at session init", () => {
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

    it("overrides tool titles + descriptions from the gateway config", async () => {
        stub.nextConfig = {
            tools: {
                orchid_ask: {
                    title: "Ask Acme AI",
                    description: "Route a question to the Acme agents.",
                },
            },
            prompts: [],
        };
        const { url, stop } = await startGateway(stub);
        stopGateway = stop;

        client = new Client({ name: "test", version: "0.0.1" });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        await client.connect(transport as unknown as Transport);

        const tools = await client.listTools();
        const ask = tools.tools.find((t) => t.name === "orchid_ask");
        expect(ask?.title).toBe("Ask Acme AI");
        expect(ask?.description).toBe("Route a question to the Acme agents.");
        expect(stub.configFetchCalls).toBe(1);
    });

    it("leaves other tools' defaults intact when only one is overridden", async () => {
        stub.nextConfig = {
            tools: { orchid_ask: { title: "Overridden" } },
            prompts: [],
        };
        const { url, stop } = await startGateway(stub);
        stopGateway = stop;

        client = new Client({ name: "test", version: "0.0.1" });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        await client.connect(transport as unknown as Transport);

        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name).sort();
        expect(names).toEqual([
            "orchid_ask",
            "orchid_list_chats",
            "orchid_new_chat",
            "orchid_resume_chat",
            "orchid_switch_chat",
            "orchid_upload_file",
        ]);
        const newChat = tools.tools.find((t) => t.name === "orchid_new_chat");
        // Default title from the source — NOT overridden.
        expect(newChat?.title).toBe("Start a new Orchid chat");
    });

    it("registers prompts and renders templates on prompts/get", async () => {
        stub.nextConfig = {
            tools: {},
            prompts: [
                {
                    name: "greet",
                    title: "Greet",
                    description: "Say hello",
                    arguments: [
                        { name: "who", description: "Who to greet", required: true },
                    ],
                    template: "Say hello to {{who}}.",
                },
            ],
        };
        const { url, stop } = await startGateway(stub);
        stopGateway = stop;

        client = new Client({ name: "test", version: "0.0.1" });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        await client.connect(transport as unknown as Transport);

        const prompts = await client.listPrompts();
        expect(prompts.prompts.map((p) => p.name)).toEqual(["greet"]);

        const result = await client.getPrompt({
            name: "greet",
            arguments: { who: "Alice" },
        });
        const text = (result.messages[0]?.content as { text: string }).text;
        expect(text).toBe("Say hello to Alice.");
    });

    it("unknown tool names in config are ignored (not fatal)", async () => {
        stub.nextConfig = {
            tools: {
                ghost_tool: { title: "Not real" },
                orchid_ask: { title: "Real" },
            },
            prompts: [],
        };
        const { url, stop } = await startGateway(stub);
        stopGateway = stop;

        client = new Client({ name: "test", version: "0.0.1" });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        await client.connect(transport as unknown as Transport);

        const tools = await client.listTools();
        const ask = tools.tools.find((t) => t.name === "orchid_ask");
        expect(ask?.title).toBe("Real");
        expect(tools.tools.some((t) => t.name === "ghost_tool")).toBe(false);
    });

    it("config fetch is attempted once per session", async () => {
        const { url, stop } = await startGateway(stub);
        stopGateway = stop;

        client = new Client({ name: "test", version: "0.0.1" });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        await client.connect(transport as unknown as Transport);

        await client.listTools();
        await client.listTools();
        expect(stub.configFetchCalls).toBe(1);
    });
});
