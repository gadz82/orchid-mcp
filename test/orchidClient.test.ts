import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, delay, http } from "msw";
import { setupServer } from "msw/node";

import {
    OrchidGatewayError,
    OrchidResponseShapeError,
    OrchidServerError,
    OrchidTimeoutError,
    OrchidUnauthorizedError,
} from "../src/errors.js";
import { UndiciOrchidAPIClient, isTimeoutLike } from "../src/http/undiciOrchidClient.js";
import type { CallOptions } from "../src/http/orchidClient.js";

const BASE = "http://orchid.test";

const server = setupServer();

beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
    server.resetHandlers();
});
afterAll(() => {
    server.close();
});

let client: UndiciOrchidAPIClient;

beforeEach(() => {
    // Use global fetch so msw can intercept. The production code uses the
    // undici.Agent-backed path (exercised in server.test.ts + live boots).
    client = new UndiciOrchidAPIClient({ baseUrl: BASE, timeoutMs: 5_000, fetchImpl: fetch });
});

const bearerOpts: CallOptions = { bearer: "tok-abc" };
const fullOpts: CallOptions = {
    bearer: "tok-abc",
    authDomain: "acme.example.com",
    requestId: "req-42",
};

describe("UndiciOrchidAPIClient — headers", () => {
    it("always sends Authorization: Bearer", async () => {
        let seen: Headers | null = null;
        server.use(
            http.get(`${BASE}/chats`, ({ request }) => {
                seen = request.headers;
                return HttpResponse.json([]);
            }),
        );
        await client.listChats(bearerOpts);
        const captured = seen as unknown as Headers;
        expect(captured).not.toBeNull();
        expect(captured.get("authorization")).toBe("Bearer tok-abc");
        expect(captured.get("x-auth-domain")).toBeNull();
        expect(captured.get("x-request-id")).toBeNull();
    });

    it("propagates x-auth-domain and X-Request-ID when provided", async () => {
        let seen: Headers | null = null;
        server.use(
            http.get(`${BASE}/chats`, ({ request }) => {
                seen = request.headers;
                return HttpResponse.json([]);
            }),
        );
        await client.listChats(fullOpts);
        const captured = seen as unknown as Headers;
        expect(captured).not.toBeNull();
        expect(captured.get("x-auth-domain")).toBe("acme.example.com");
        expect(captured.get("x-request-id")).toBe("req-42");
    });
});

describe("UndiciOrchidAPIClient — createChat", () => {
    it("POSTs JSON and returns the parsed ChatSession", async () => {
        let body: unknown;
        server.use(
            http.post(`${BASE}/chats`, async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({
                    id: "c1",
                    title: "My chat",
                    created_at: "2025-01-01T00:00:00Z",
                    updated_at: "2025-01-01T00:00:00Z",
                    is_shared: false,
                });
            }),
        );

        const session = await client.createChat(bearerOpts, "My chat");

        expect(body).toEqual({ title: "My chat" });
        expect(session.id).toBe("c1");
        expect(session.title).toBe("My chat");
        expect(session.is_shared).toBe(false);
    });

    it("sends an empty title when none provided", async () => {
        let body: unknown;
        server.use(
            http.post(`${BASE}/chats`, async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({
                    id: "c1",
                    title: "New chat",
                    created_at: "t",
                    updated_at: "t",
                    is_shared: false,
                });
            }),
        );
        await client.createChat(bearerOpts);
        expect(body).toEqual({ title: "" });
    });
});

describe("UndiciOrchidAPIClient — listChats", () => {
    it("returns an array of ChatSessions", async () => {
        server.use(
            http.get(`${BASE}/chats`, () =>
                HttpResponse.json([
                    {
                        id: "c1",
                        title: "One",
                        created_at: "t",
                        updated_at: "t",
                        is_shared: false,
                    },
                    {
                        id: "c2",
                        title: "Two",
                        created_at: "t",
                        updated_at: "t",
                        is_shared: true,
                    },
                ]),
            ),
        );
        const out = await client.listChats(bearerOpts);
        expect(out.map((c) => c.id)).toEqual(["c1", "c2"]);
        expect(out[1]?.is_shared).toBe(true);
    });
});

describe("UndiciOrchidAPIClient — getMessages", () => {
    it("sends limit + offset query params and parses MessageOut[]", async () => {
        let seenUrl: string | null = null;
        server.use(
            http.get(`${BASE}/chats/:id/messages`, ({ request }) => {
                seenUrl = request.url;
                return HttpResponse.json([
                    {
                        id: "m1",
                        role: "user",
                        content: "hi",
                        agents_used: [],
                        created_at: "t",
                    },
                ]);
            }),
        );
        const msgs = await client.getMessages(bearerOpts, "chat-1", 10, 20);
        expect(seenUrl).not.toBeNull();
        const url = new URL(seenUrl as unknown as string);
        expect(url.pathname).toBe("/chats/chat-1/messages");
        expect(url.searchParams.get("limit")).toBe("10");
        expect(url.searchParams.get("offset")).toBe("20");
        expect(msgs[0]?.content).toBe("hi");
    });

    it("defaults limit to 50 and offset to 0", async () => {
        let url: URL | null = null;
        server.use(
            http.get(`${BASE}/chats/:id/messages`, ({ request }) => {
                url = new URL(request.url);
                return HttpResponse.json([]);
            }),
        );
        await client.getMessages(bearerOpts, "c");
        const captured = url as unknown as URL;
        expect(captured).not.toBeNull();
        expect(captured.searchParams.get("limit")).toBe("50");
        expect(captured.searchParams.get("offset")).toBe("0");
    });
});

describe("UndiciOrchidAPIClient — sendMessage", () => {
    it("POSTs multipart with message + files and parses a ChatResponse", async () => {
        let form: FormData | null = null;
        server.use(
            http.post(`${BASE}/chats/:id/messages`, async ({ request }) => {
                form = await request.formData();
                return HttpResponse.json({
                    response: "Answer",
                    chat_id: "chat-1",
                    tenant_id: "t1",
                    agents_used: ["basketball"],
                    auth_required: [],
                });
            }),
        );

        const result = await client.sendMessage(bearerOpts, "chat-1", "Tell me about LeBron", [
            { filename: "note.txt", content: Buffer.from("scouting"), mimeType: "text/plain" },
        ]);

        expect("response" in result && result.response).toBe("Answer");
        const captured = form as unknown as FormData;
        expect(captured).not.toBeNull();
        expect(captured.get("message")).toBe("Tell me about LeBron");
        const file = captured.get("files");
        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("note.txt");
        expect((file as File).type).toBe("text/plain");
        expect(await (file as File).text()).toBe("scouting");
    });

    it("surfaces an InterruptResponse as a parsed SendResult", async () => {
        server.use(
            http.post(`${BASE}/chats/:id/messages`, () =>
                HttpResponse.json({
                    chat_id: "chat-1",
                    tenant_id: "t1",
                    status: "interrupted",
                    approvals_needed: [
                        {
                            tool: "book_restaurant",
                            args: { party: 4 },
                            agent: "concierge",
                            interrupt_id: "int-1",
                        },
                    ],
                }),
            ),
        );

        const result = await client.sendMessage(bearerOpts, "chat-1", "book it");

        if (!("status" in result)) {
            throw new Error("expected interrupt shape");
        }
        expect(result.status).toBe("interrupted");
        expect(result.approvals_needed[0]?.tool).toBe("book_restaurant");
        expect(result.approvals_needed[0]?.interrupt_id).toBe("int-1");
    });

    it("handles an empty files list without attaching a files part", async () => {
        let form: FormData | null = null;
        server.use(
            http.post(`${BASE}/chats/:id/messages`, async ({ request }) => {
                form = await request.formData();
                return HttpResponse.json({
                    response: "ok",
                    chat_id: "chat-1",
                    tenant_id: "t1",
                    agents_used: [],
                    auth_required: [],
                });
            }),
        );
        await client.sendMessage(bearerOpts, "chat-1", "hello");
        const captured = form as unknown as FormData;
        expect(captured.get("message")).toBe("hello");
        expect(captured.get("files")).toBeNull();
    });
});

describe("UndiciOrchidAPIClient — resume", () => {
    it("POSTs {approved} as JSON and parses the result", async () => {
        let body: unknown;
        server.use(
            http.post(`${BASE}/chats/:id/resume`, async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({
                    response: "Resumed",
                    chat_id: "chat-1",
                    tenant_id: "t1",
                    agents_used: [],
                    auth_required: [],
                });
            }),
        );
        const out = await client.resume(bearerOpts, "chat-1", true);
        expect(body).toEqual({ approved: true });
        expect("response" in out && out.response).toBe("Resumed");
    });

    it("forwards approved=false", async () => {
        let body: unknown;
        server.use(
            http.post(`${BASE}/chats/:id/resume`, async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({
                    response: "Skipped",
                    chat_id: "chat-1",
                    tenant_id: "t1",
                    agents_used: [],
                    auth_required: [],
                });
            }),
        );
        await client.resume(bearerOpts, "chat-1", false);
        expect(body).toEqual({ approved: false });
    });
});

describe("UndiciOrchidAPIClient — upload", () => {
    it("POSTs multipart files and parses the upload response", async () => {
        let form: FormData | null = null;
        server.use(
            http.post(`${BASE}/chats/:id/upload`, async ({ request }) => {
                form = await request.formData();
                return HttpResponse.json({
                    status: "ok",
                    files: [{ filename: "a.pdf", chunks_indexed: 7 }],
                });
            }),
        );
        const res = await client.upload(bearerOpts, "chat-1", [
            { filename: "a.pdf", content: Buffer.from("%PDF-1.4"), mimeType: "application/pdf" },
        ]);
        expect(res.status).toBe("ok");
        expect(res.files[0]).toEqual({ filename: "a.pdf", chunks_indexed: 7 });
        const captured = form as unknown as FormData;
        expect(captured).not.toBeNull();
        const file = captured.get("files") as File;
        expect(file.name).toBe("a.pdf");
        expect(file.type).toBe("application/pdf");
    });

    it("refuses an empty files list before any HTTP call", async () => {
        await expect(client.upload(bearerOpts, "chat-1", [])).rejects.toBeInstanceOf(
            OrchidGatewayError,
        );
    });
});

describe("UndiciOrchidAPIClient — error mapping", () => {
    it("maps 401 to OrchidUnauthorizedError", async () => {
        server.use(
            http.get(`${BASE}/chats`, () =>
                HttpResponse.json({ detail: "Authentication failed" }, { status: 401 }),
            ),
        );
        await expect(client.listChats(bearerOpts)).rejects.toBeInstanceOf(OrchidUnauthorizedError);
    });

    it("maps 403 to OrchidUnauthorizedError", async () => {
        server.use(
            http.get(`${BASE}/chats`, () =>
                HttpResponse.json({ detail: "Forbidden" }, { status: 403 }),
            ),
        );
        await expect(client.listChats(bearerOpts)).rejects.toBeInstanceOf(OrchidUnauthorizedError);
    });

    it("maps 422 to OrchidServerError with the status and parsed body", async () => {
        server.use(
            http.post(`${BASE}/chats`, () =>
                HttpResponse.json({ detail: [{ loc: ["title"], msg: "nope" }] }, { status: 422 }),
            ),
        );
        try {
            await client.createChat(bearerOpts);
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(OrchidServerError);
            const se = err as OrchidServerError;
            expect(se.status).toBe(422);
            expect(se.body).toMatchObject({ detail: [{ loc: ["title"], msg: "nope" }] });
        }
    });

    it("maps 500 to OrchidServerError and preserves a non-JSON body as a string", async () => {
        server.use(http.get(`${BASE}/chats`, () => new HttpResponse("kaboom", { status: 500 })));
        try {
            await client.listChats(bearerOpts);
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(OrchidServerError);
            const se = err as OrchidServerError;
            expect(se.status).toBe(500);
            expect(se.body).toBe("kaboom");
        }
    });

    it("throws OrchidResponseShapeError on malformed JSON success body", async () => {
        server.use(http.get(`${BASE}/chats`, () => new HttpResponse("not json", { status: 200 })));
        await expect(client.listChats(bearerOpts)).rejects.toBeInstanceOf(OrchidResponseShapeError);
    });

    it("throws OrchidResponseShapeError when the response violates the schema", async () => {
        server.use(http.get(`${BASE}/chats`, () => HttpResponse.json([{ id: "c1", title: "x" }])));
        await expect(client.listChats(bearerOpts)).rejects.toBeInstanceOf(OrchidResponseShapeError);
    });

    it("throws OrchidTimeoutError when the request exceeds timeoutMs", async () => {
        const shortClient = new UndiciOrchidAPIClient({
            baseUrl: BASE,
            timeoutMs: 50,
            fetchImpl: fetch,
        });
        server.use(
            http.get(`${BASE}/chats`, async () => {
                await delay(500);
                return HttpResponse.json([]);
            }),
        );
        await expect(shortClient.listChats(bearerOpts)).rejects.toBeInstanceOf(OrchidTimeoutError);
    });

    it("maps a generic network failure to OrchidGatewayError", async () => {
        server.use(http.get(`${BASE}/chats`, () => HttpResponse.error()));
        const p = client.listChats(bearerOpts);
        await expect(p).rejects.toBeInstanceOf(OrchidGatewayError);
        await expect(p).rejects.not.toBeInstanceOf(OrchidTimeoutError);
    });

    it("trims a trailing slash from the base URL", async () => {
        const withSlash = new UndiciOrchidAPIClient({
            baseUrl: `${BASE}/`,
            timeoutMs: 5_000,
            fetchImpl: fetch,
        });
        server.use(http.get(`${BASE}/chats`, () => HttpResponse.json([])));
        await withSlash.listChats(bearerOpts);
    });
});

describe("UndiciOrchidAPIClient — sendMessageStream", () => {
    function sseBody(events: string[]): ReadableStream<Uint8Array> {
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
            start(controller) {
                for (const ev of events) {
                    controller.enqueue(encoder.encode(ev));
                }
                controller.close();
            },
        });
    }

    it("parses SSE frames, forwards to onEvent, and returns the done payload", async () => {
        server.use(
            http.post(`${BASE}/chats/:id/messages/stream`, () => {
                return new Response(
                    sseBody([
                        'data: {"type":"token","content":"Hello "}\n\n',
                        'data: {"type":"token","content":"world."}\n\n',
                        'data: {"type":"done","response":"Hello world.","agents_used":["x"],"agent_results":{},"auth_required":[]}\n\n',
                    ]),
                    { headers: { "Content-Type": "text/event-stream" } },
                );
            }),
        );
        const events: string[] = [];
        const done = await client.sendMessageStream(bearerOpts, "chat-1", "hi", undefined, {
            onEvent: (e) => {
                events.push(e.type);
            },
        });
        expect(events).toEqual(["token", "token", "done"]);
        expect(done.response).toBe("Hello world.");
        expect(done.agents_used).toEqual(["x"]);
    });

    it("throws OrchidGatewayError when the stream ends with an error event", async () => {
        server.use(
            http.post(`${BASE}/chats/:id/messages/stream`, () => {
                return new Response(sseBody(['data: {"type":"error","message":"kaboom"}\n\n']), {
                    headers: { "Content-Type": "text/event-stream" },
                });
            }),
        );
        await expect(
            client.sendMessageStream(bearerOpts, "chat-1", "hi", undefined, {
                onEvent: () => {
                    /* ignore */
                },
            }),
        ).rejects.toBeInstanceOf(OrchidGatewayError);
    });

    it("throws OrchidResponseShapeError when the stream never sends done", async () => {
        server.use(
            http.post(`${BASE}/chats/:id/messages/stream`, () => {
                return new Response(sseBody(['data: {"type":"token","content":"x"}\n\n']), {
                    headers: { "Content-Type": "text/event-stream" },
                });
            }),
        );
        await expect(
            client.sendMessageStream(bearerOpts, "chat-1", "hi", undefined, {
                onEvent: () => {
                    /* ignore */
                },
            }),
        ).rejects.toBeInstanceOf(OrchidResponseShapeError);
    });

    it("skips malformed frames and unknown event shapes", async () => {
        server.use(
            http.post(`${BASE}/chats/:id/messages/stream`, () => {
                return new Response(
                    sseBody([
                        "data: not-json\n\n",
                        'data: {"type":"frobnicate","weird":true}\n\n',
                        'data: {"type":"done","response":"ok","agents_used":[],"agent_results":{},"auth_required":[]}\n\n',
                    ]),
                    { headers: { "Content-Type": "text/event-stream" } },
                );
            }),
        );
        const seen: string[] = [];
        const done = await client.sendMessageStream(bearerOpts, "chat-1", "hi", undefined, {
            onEvent: (e) => {
                seen.push(e.type);
            },
        });
        expect(seen).toEqual(["done"]);
        expect(done.response).toBe("ok");
    });

    it("propagates 401 as OrchidUnauthorizedError", async () => {
        server.use(
            http.post(`${BASE}/chats/:id/messages/stream`, () =>
                HttpResponse.json({ detail: "nope" }, { status: 401 }),
            ),
        );
        await expect(
            client.sendMessageStream(bearerOpts, "chat-1", "hi", undefined, {
                onEvent: () => {
                    /* ignore */
                },
            }),
        ).rejects.toBeInstanceOf(OrchidUnauthorizedError);
    });

    it("propagates non-2xx as OrchidServerError", async () => {
        server.use(
            http.post(`${BASE}/chats/:id/messages/stream`, () =>
                HttpResponse.json({ detail: "boom" }, { status: 500 }),
            ),
        );
        await expect(
            client.sendMessageStream(bearerOpts, "chat-1", "hi", undefined, {
                onEvent: () => {
                    /* ignore */
                },
            }),
        ).rejects.toBeInstanceOf(OrchidServerError);
    });

    it("throws OrchidResponseShapeError when the stream response body is null", async () => {
        server.use(
            http.post(`${BASE}/chats/:id/messages/stream`, () => {
                return new Response(null, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                });
            }),
        );
        await expect(
            client.sendMessageStream(bearerOpts, "chat-1", "hi", undefined, {
                onEvent: () => { /* ignore */ },
            }),
        ).rejects.toBeInstanceOf(OrchidResponseShapeError);
    });

    it("maps a network error during streaming to OrchidGatewayError", async () => {
        server.use(http.post(`${BASE}/chats/:id/messages/stream`, () => HttpResponse.error()));
        await expect(
            client.sendMessageStream(bearerOpts, "chat-1", "hi", undefined, {
                onEvent: () => { /* ignore */ },
            }),
        ).rejects.toBeInstanceOf(OrchidGatewayError);
    });

    it("maps an abort signal firing before the response to OrchidTimeoutError", async () => {
        server.use(
            http.post(`${BASE}/chats/:id/messages/stream`, async () => {
                await delay(500);
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.close();
                        },
                    }),
                    { headers: { "Content-Type": "text/event-stream" } },
                );
            }),
        );
        const controller = new AbortController();
        const p = client.sendMessageStream(bearerOpts, "chat-1", "hi", undefined, {
            onEvent: () => {
                /* ignore */
            },
            signal: controller.signal,
        });
        controller.abort();
        await expect(p).rejects.toBeInstanceOf(OrchidGatewayError);
    });

    it("forwards x-auth-domain and X-Request-ID on the streaming request", async () => {
        let seen: Headers | null = null;
        server.use(
            http.post(`${BASE}/chats/:id/messages/stream`, ({ request }) => {
                seen = request.headers;
                return new Response(
                    sseBody([
                        'data: {"type":"done","response":"ok","agents_used":[],"agent_results":{},"auth_required":[]}\n\n',
                    ]),
                    { headers: { "Content-Type": "text/event-stream" } },
                );
            }),
        );
        await client.sendMessageStream(fullOpts, "chat-1", "hi", undefined, {
            onEvent: () => {
                /* ignore */
            },
        });
        const headers = seen as unknown as Headers;
        expect(headers.get("x-auth-domain")).toBe("acme.example.com");
        expect(headers.get("x-request-id")).toBe("req-42");
    });
});

describe("UndiciOrchidAPIClient — getGatewayConfig", () => {
    it("parses a full gateway config", async () => {
        server.use(
            http.get(`${BASE}/mcp-gateway/config`, () =>
                HttpResponse.json({
                    tools: {
                        orchid_ask: {
                            title: "Ask Acme",
                            description: "Route a question.",
                        },
                    },
                    prompts: [
                        {
                            name: "greet",
                            title: "Greet",
                            description: "Say hello",
                            arguments: [{ name: "who", required: true }],
                            template: "Hi {{who}}.",
                        },
                    ],
                }),
            ),
        );
        const cfg = await client.getGatewayConfig(bearerOpts);
        expect(cfg.tools.orchid_ask?.title).toBe("Ask Acme");
        expect(cfg.prompts[0]?.name).toBe("greet");
        expect(cfg.prompts[0]?.arguments[0]?.required).toBe(true);
    });

    it("defaults empty tools + prompts when orchid-api omits them", async () => {
        server.use(http.get(`${BASE}/mcp-gateway/config`, () => HttpResponse.json({})));
        const cfg = await client.getGatewayConfig(bearerOpts);
        expect(cfg.tools).toEqual({});
        expect(cfg.prompts).toEqual([]);
    });

    it("maps 401 to OrchidUnauthorizedError (flows through standard auth chain)", async () => {
        server.use(
            http.get(`${BASE}/mcp-gateway/config`, () =>
                HttpResponse.json({ detail: "nope" }, { status: 401 }),
            ),
        );
        await expect(client.getGatewayConfig(bearerOpts)).rejects.toBeInstanceOf(
            OrchidUnauthorizedError,
        );
    });

    it("sends the Authorization header", async () => {
        let seen: Headers | null = null;
        server.use(
            http.get(`${BASE}/mcp-gateway/config`, ({ request }) => {
                seen = request.headers;
                return HttpResponse.json({ tools: {}, prompts: [] });
            }),
        );
        await client.getGatewayConfig(bearerOpts);
        expect((seen as unknown as Headers).get("authorization")).toBe("Bearer tok-abc");
    });
});

describe("UndiciOrchidAPIClient — getAuthInfo", () => {
    it("parses a valid response (no Authorization header sent)", async () => {
        let seen: Headers | null = null;
        server.use(
            http.get(`${BASE}/auth-info`, ({ request }) => {
                seen = request.headers;
                return HttpResponse.json({
                    dev_bypass: true,
                    identity_resolver_configured: false,
                });
            }),
        );
        const info = await client.getAuthInfo();
        expect(info.dev_bypass).toBe(true);
        expect(info.identity_resolver_configured).toBe(false);
        const headers = seen as unknown as Headers;
        expect(headers.get("authorization")).toBeNull();
    });

    it("maps 5xx to OrchidServerError", async () => {
        server.use(
            http.get(`${BASE}/auth-info`, () =>
                HttpResponse.json({ error: "boom" }, { status: 503 }),
            ),
        );
        await expect(client.getAuthInfo()).rejects.toBeInstanceOf(OrchidServerError);
    });

    it("rejects a response missing required fields", async () => {
        server.use(http.get(`${BASE}/auth-info`, () => HttpResponse.json({ only: "junk" })));
        await expect(client.getAuthInfo()).rejects.toBeInstanceOf(OrchidResponseShapeError);
    });

    it("parses an oauth discovery block when orchid-api includes one", async () => {
        server.use(
            http.get(`${BASE}/auth-info`, () =>
                HttpResponse.json({
                    dev_bypass: false,
                    identity_resolver_configured: true,
                    oauth: {
                        issuer_url: "https://acme.example.com",
                        authorization_endpoint: "https://acme.example.com/oauth2/authorize",
                        token_endpoint: "https://acme.example.com/oauth2/token",
                        userinfo_endpoint: "https://acme.example.com/manage/v1/user/session",
                        client_id: "mcp-gateway",
                        scope: "api",
                    },
                }),
            ),
        );
        const info = await client.getAuthInfo();
        expect(info.oauth).toBeDefined();
        expect(info.oauth?.issuer_url).toBe("https://acme.example.com");
        expect(info.oauth?.client_id).toBe("mcp-gateway");
        expect(info.oauth?.scope).toBe("api");
    });

    it("defaults oauth scope to empty string when orchid-api omits it", async () => {
        server.use(
            http.get(`${BASE}/auth-info`, () =>
                HttpResponse.json({
                    dev_bypass: false,
                    identity_resolver_configured: true,
                    oauth: {
                        issuer_url: "https://acme.example.com",
                        authorization_endpoint: "https://acme.example.com/oauth2/authorize",
                        token_endpoint: "https://acme.example.com/oauth2/token",
                        client_id: "c",
                    },
                }),
            ),
        );
        const info = await client.getAuthInfo();
        expect(info.oauth?.scope).toBe("");
    });

    it("accepts oauth: null (provider wired but disabled) without throwing", async () => {
        server.use(
            http.get(`${BASE}/auth-info`, () =>
                HttpResponse.json({
                    dev_bypass: false,
                    identity_resolver_configured: true,
                    oauth: null,
                }),
            ),
        );
        const info = await client.getAuthInfo();
        expect(info.oauth).toBeNull();
    });

    it("rejects a malformed oauth block (missing client_id)", async () => {
        server.use(
            http.get(`${BASE}/auth-info`, () =>
                HttpResponse.json({
                    dev_bypass: false,
                    identity_resolver_configured: true,
                    oauth: {
                        issuer_url: "https://acme.example.com",
                        authorization_endpoint: "https://acme.example.com/a",
                        token_endpoint: "https://acme.example.com/t",
                        // client_id intentionally omitted
                    },
                }),
            ),
        );
        await expect(client.getAuthInfo()).rejects.toBeInstanceOf(OrchidResponseShapeError);
    });

    it("maps a network error to OrchidGatewayError", async () => {
        server.use(http.get(`${BASE}/auth-info`, () => HttpResponse.error()));
        await expect(client.getAuthInfo()).rejects.toBeInstanceOf(OrchidGatewayError);
    });

    it("maps a timeout to OrchidTimeoutError", async () => {
        const shortClient = new UndiciOrchidAPIClient({
            baseUrl: BASE,
            timeoutMs: 50,
            fetchImpl: fetch,
        });
        server.use(
            http.get(`${BASE}/auth-info`, async () => {
                await delay(500);
                return HttpResponse.json({ dev_bypass: true, identity_resolver_configured: false });
            }),
        );
        await expect(shortClient.getAuthInfo()).rejects.toBeInstanceOf(OrchidTimeoutError);
    });
});

describe("UndiciOrchidAPIClient — getMcpServerAuthorizeUrl", () => {
    it("GETs the per-server endpoint and returns the parsed URL + state", async () => {
        let seen: Headers | null = null;
        let seenUrl: string | null = null;
        server.use(
            http.get(`${BASE}/mcp/auth/servers/:name/authorize`, ({ request }) => {
                seen = request.headers;
                seenUrl = request.url;
                return HttpResponse.json({
                    authorize_url: "https://idp.example.com/oauth/authorize?state=abc",
                    state: "abc",
                });
            }),
        );
        const out = await client.getMcpServerAuthorizeUrl(bearerOpts, "github");
        expect(out.authorize_url).toBe("https://idp.example.com/oauth/authorize?state=abc");
        expect(out.state).toBe("abc");
        const headers = seen as unknown as Headers;
        expect(headers.get("authorization")).toBe("Bearer tok-abc");
        expect(seenUrl).toBe(`${BASE}/mcp/auth/servers/github/authorize`);
    });

    it("URL-encodes the server name", async () => {
        let seenUrl: string | null = null;
        server.use(
            http.get(`${BASE}/mcp/auth/servers/:name/authorize`, ({ request }) => {
                seenUrl = request.url;
                return HttpResponse.json({
                    authorize_url: "https://idp.example.com/a",
                    state: "s",
                });
            }),
        );
        await client.getMcpServerAuthorizeUrl(bearerOpts, "weird name/slash");
        // msw normalises back to a readable path — assert it includes the
        // percent-encoded segment produced by encodeURIComponent.
        expect(seenUrl).toContain("weird%20name%2Fslash");
    });

    it("maps a 404 to OrchidServerError (unknown server, shouldn't happen but surface cleanly)", async () => {
        server.use(
            http.get(`${BASE}/mcp/auth/servers/:name/authorize`, () =>
                HttpResponse.json({ detail: "no such server" }, { status: 404 }),
            ),
        );
        await expect(client.getMcpServerAuthorizeUrl(bearerOpts, "ghost")).rejects.toBeInstanceOf(
            OrchidServerError,
        );
    });

    it("maps 401 to OrchidUnauthorizedError", async () => {
        server.use(
            http.get(`${BASE}/mcp/auth/servers/:name/authorize`, () =>
                HttpResponse.json({ detail: "nope" }, { status: 401 }),
            ),
        );
        await expect(client.getMcpServerAuthorizeUrl(bearerOpts, "github")).rejects.toBeInstanceOf(
            OrchidUnauthorizedError,
        );
    });

    it("rejects a response whose authorize_url is not a URL", async () => {
        server.use(
            http.get(`${BASE}/mcp/auth/servers/:name/authorize`, () =>
                HttpResponse.json({ authorize_url: "not-a-url", state: "s" }),
            ),
        );
        await expect(client.getMcpServerAuthorizeUrl(bearerOpts, "github")).rejects.toBeInstanceOf(
            OrchidResponseShapeError,
        );
    });

    it("propagates authDomain + requestId headers", async () => {
        let seen: Headers | null = null;
        server.use(
            http.get(`${BASE}/mcp/auth/servers/:name/authorize`, ({ request }) => {
                seen = request.headers;
                return HttpResponse.json({
                    authorize_url: "https://idp.example.com/a",
                    state: "s",
                });
            }),
        );
        await client.getMcpServerAuthorizeUrl(fullOpts, "github");
        const headers = seen as unknown as Headers;
        expect(headers.get("x-auth-domain")).toBe("acme.example.com");
        expect(headers.get("x-request-id")).toBe("req-42");
    });
});

describe("UndiciOrchidAPIClient — exchangeAuthorizationCode", () => {
    it("POSTs JSON to /auth/exchange-code and parses the token response", async () => {
        let seen: { headers: Headers | null; body: string | null } = {
            headers: null,
            body: null,
        };
        server.use(
            http.post(`${BASE}/auth/exchange-code`, async ({ request }) => {
                seen = { headers: request.headers, body: await request.text() };
                return HttpResponse.json({
                    access_token: "at-exchanged",
                    token_type: "Bearer",
                    refresh_token: "rt-exchanged",
                    expires_in: 3600,
                    scope: "api",
                });
            }),
        );
        const out = await client.exchangeAuthorizationCode(bearerOpts, {
            code: "the-code",
            redirect_uri: "http://localhost:9000/oauth/callback",
            code_verifier: "the-verifier",
        });
        expect(out.access_token).toBe("at-exchanged");
        expect(out.refresh_token).toBe("rt-exchanged");
        expect(out.expires_in).toBe(3600);
        expect(out.scope).toBe("api");

        const body = JSON.parse(seen.body ?? "{}") as Record<string, unknown>;
        expect(body).toEqual({
            code: "the-code",
            redirect_uri: "http://localhost:9000/oauth/callback",
            code_verifier: "the-verifier",
        });
        const headers = seen.headers as unknown as Headers;
        expect(headers.get("content-type")).toMatch(/application\/json/i);
    });

    it("omits code_verifier when the caller doesn't provide one", async () => {
        let capturedBody: Record<string, unknown> = {};
        server.use(
            http.post(`${BASE}/auth/exchange-code`, async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({ access_token: "at" });
            }),
        );
        await client.exchangeAuthorizationCode(bearerOpts, {
            code: "c",
            redirect_uri: "http://cb",
        });
        expect("code_verifier" in capturedBody).toBe(false);
    });

    it("maps upstream 400 (invalid_grant passthrough) to OrchidServerError", async () => {
        server.use(
            http.post(`${BASE}/auth/exchange-code`, () =>
                HttpResponse.json({ detail: "invalid_grant" }, { status: 400 }),
            ),
        );
        await expect(
            client.exchangeAuthorizationCode(bearerOpts, {
                code: "c",
                redirect_uri: "http://cb",
            }),
        ).rejects.toBeInstanceOf(OrchidServerError);
    });

    it("maps upstream 502 (IdP unreachable via orchid-api) to OrchidServerError", async () => {
        server.use(
            http.post(`${BASE}/auth/exchange-code`, () =>
                HttpResponse.json({ detail: "bad gateway" }, { status: 502 }),
            ),
        );
        await expect(
            client.exchangeAuthorizationCode(bearerOpts, {
                code: "c",
                redirect_uri: "http://cb",
            }),
        ).rejects.toBeInstanceOf(OrchidServerError);
    });

    it("rejects a response missing access_token (zod shape error)", async () => {
        server.use(
            http.post(`${BASE}/auth/exchange-code`, () =>
                HttpResponse.json({ token_type: "Bearer", scope: "api" }),
            ),
        );
        await expect(
            client.exchangeAuthorizationCode(bearerOpts, {
                code: "c",
                redirect_uri: "http://cb",
            }),
        ).rejects.toBeInstanceOf(OrchidResponseShapeError);
    });
});

describe("UndiciOrchidAPIClient — resolveIdentity", () => {
    it("POSTs JSON to /auth/resolve-identity and returns the parsed identity", async () => {
        let seen: { body: string | null; authz: string | null } = {
            body: null,
            authz: null,
        };
        server.use(
            http.post(`${BASE}/auth/resolve-identity`, async ({ request }) => {
                seen = {
                    body: await request.text(),
                    authz: request.headers.get("authorization"),
                };
                return HttpResponse.json({
                    subject: "u-42",
                    bearer: "tok-echoed",
                    auth_domain: "acme.example.com",
                    email: "a@b.c",
                    extra: { installation_id: 195128 },
                });
            }),
        );
        const out = await client.resolveIdentity({
            access_token: "tok-abc",
            auth_domain: "acme.example.com",
        });
        expect(out.subject).toBe("u-42");
        expect(out.bearer).toBe("tok-echoed");
        expect(out.auth_domain).toBe("acme.example.com");
        expect(out.email).toBe("a@b.c");
        expect(out.extra).toEqual({ installation_id: 195128 });

        // Body: snake_case wire shape, auth_domain passed through.
        expect(JSON.parse(seen.body ?? "{}")).toEqual({
            access_token: "tok-abc",
            auth_domain: "acme.example.com",
        });
        // Authorization header is present but carries an empty
        // bearer — the endpoint is unauthenticated on the server
        // side.  ``fetch`` trims the trailing space so what we see
        // is "Bearer".  Either form is harmless; orchid-api ignores
        // the header on this endpoint.
        expect(seen.authz).toMatch(/^Bearer\s*$/);
    });

    it("omits auth_domain from the body when the caller doesn't provide one", async () => {
        let body: Record<string, unknown> = {};
        server.use(
            http.post(`${BASE}/auth/resolve-identity`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({
                    subject: "u-1",
                    bearer: "tok",
                    auth_domain: "",
                    email: "",
                    extra: {},
                });
            }),
        );
        await client.resolveIdentity({ access_token: "tok" });
        expect("auth_domain" in body).toBe(false);
    });

    it("maps upstream 401 (expired token) to OrchidUnauthorizedError", async () => {
        server.use(
            http.post(`${BASE}/auth/resolve-identity`, () =>
                HttpResponse.json({ detail: "expired token" }, { status: 401 }),
            ),
        );
        await expect(client.resolveIdentity({ access_token: "bad" })).rejects.toBeInstanceOf(
            OrchidUnauthorizedError,
        );
    });

    it("maps upstream 502 (upstream unreachable) to OrchidServerError", async () => {
        server.use(
            http.post(`${BASE}/auth/resolve-identity`, () =>
                HttpResponse.json({ detail: "bad gateway" }, { status: 502 }),
            ),
        );
        await expect(client.resolveIdentity({ access_token: "tok" })).rejects.toBeInstanceOf(
            OrchidServerError,
        );
    });

    it("rejects a response missing subject (zod shape error)", async () => {
        server.use(
            http.post(`${BASE}/auth/resolve-identity`, () =>
                // Missing ``subject`` — must not silently pass through.
                HttpResponse.json({ bearer: "tok" }),
            ),
        );
        await expect(client.resolveIdentity({ access_token: "tok" })).rejects.toBeInstanceOf(
            OrchidResponseShapeError,
        );
    });
});

describe("UndiciOrchidAPIClient — refreshUpstreamToken", () => {
    it("POSTs JSON to /auth/refresh-token and parses the rotated token pair", async () => {
        let body: Record<string, unknown> | null = null;
        server.use(
            http.post(`${BASE}/auth/refresh-token`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({
                    access_token: "at-fresh",
                    token_type: "Bearer",
                    refresh_token: "rt-rotated",
                    expires_in: 3600,
                    scope: "api",
                });
            }),
        );
        const out = await client.refreshUpstreamToken(bearerOpts, {
            refresh_token: "rt-old",
        });
        expect(out.access_token).toBe("at-fresh");
        expect(out.refresh_token).toBe("rt-rotated");
        expect(out.expires_in).toBe(3600);
        expect(body).toEqual({ refresh_token: "rt-old" });
    });

    it("maps upstream 400 (refresh revoked) to OrchidServerError", async () => {
        server.use(
            http.post(`${BASE}/auth/refresh-token`, () =>
                HttpResponse.json({ detail: "invalid_grant" }, { status: 400 }),
            ),
        );
        await expect(
            client.refreshUpstreamToken(bearerOpts, { refresh_token: "rt-revoked" }),
        ).rejects.toBeInstanceOf(OrchidServerError);
    });

    it("maps upstream 503 (refresh_token not implemented on orchid-api side) to OrchidServerError", async () => {
        server.use(
            http.post(`${BASE}/auth/refresh-token`, () =>
                HttpResponse.json({ detail: "refresh_token not implemented" }, { status: 503 }),
            ),
        );
        await expect(
            client.refreshUpstreamToken(bearerOpts, { refresh_token: "rt" }),
        ).rejects.toBeInstanceOf(OrchidServerError);
    });

    it("rejects a response missing access_token (zod shape error)", async () => {
        server.use(
            http.post(`${BASE}/auth/refresh-token`, () =>
                HttpResponse.json({ token_type: "Bearer" }),
            ),
        );
        await expect(
            client.refreshUpstreamToken(bearerOpts, { refresh_token: "rt" }),
        ).rejects.toBeInstanceOf(OrchidResponseShapeError);
    });
});

describe("isTimeoutLike", () => {
    it("returns false for primitives and null", () => {
        expect(isTimeoutLike(null)).toBe(false);
        expect(isTimeoutLike(undefined)).toBe(false);
        expect(isTimeoutLike("oops")).toBe(false);
        expect(isTimeoutLike(42)).toBe(false);
    });

    it("returns true for an AbortError by name", () => {
        expect(isTimeoutLike(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    });

    it("returns true for a TimeoutError by name", () => {
        expect(isTimeoutLike(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
    });

    it("returns true when err.cause is a TimeoutError (undici wrapping)", () => {
        const err = new TypeError("fetch failed");
        Object.defineProperty(err, "cause", {
            value: Object.assign(new Error("t"), { name: "TimeoutError" }),
        });
        expect(isTimeoutLike(err)).toBe(true);
    });

    it("returns true when err.cause is an AbortError", () => {
        const err = new TypeError("fetch failed");
        Object.defineProperty(err, "cause", {
            value: Object.assign(new Error("t"), { name: "AbortError" }),
        });
        expect(isTimeoutLike(err)).toBe(true);
    });

    it("returns false when err.cause is an unrelated error", () => {
        const err = new TypeError("fetch failed");
        Object.defineProperty(err, "cause", {
            value: Object.assign(new Error("nope"), { name: "SomethingElse" }),
        });
        expect(isTimeoutLike(err)).toBe(false);
    });

    it("returns false when err.cause is not an object", () => {
        const err = new TypeError("fetch failed");
        Object.defineProperty(err, "cause", { value: "some string" });
        expect(isTimeoutLike(err)).toBe(false);
    });
});

describe("UndiciOrchidAPIClient — emitSignal", () => {
    it("POSTs JSON to /signals with X-Orchid-Source header and parses response", async () => {
        let seen: { body: unknown; headers: Headers | null } = { body: null, headers: null };
        server.use(
            http.post(`${BASE}/signals`, async ({ request }) => {
                seen = { body: await request.json(), headers: request.headers };
                return HttpResponse.json({ signal_id: "s-1", deduplicated: false });
            }),
        );
        const res = await client.emitSignal(bearerOpts, {
            type: "order.placed",
            tenantKey: "tk-1",
            payload: { orderId: "o-1" },
            userId: "u-1",
        });
        expect(res.signal_id).toBe("s-1");
        expect(res.deduplicated).toBe(false);
        expect(seen.body).toMatchObject({
            type: "order.placed",
            tenant_key: "tk-1",
            payload: { orderId: "o-1" },
            user_id: "u-1",
        });
        expect((seen.headers as unknown as Headers).get("x-orchid-source")).toBe("mcp-gateway");
    });

    it("sends optional fields and dedupeKey as Idempotency-Key header", async () => {
        let capturedHeaders: Headers | null = null;
        server.use(
            http.post(`${BASE}/signals`, async ({ request }) => {
                capturedHeaders = request.headers;
                return HttpResponse.json({ signal_id: "s-2", deduplicated: false });
            }),
        );
        await client.emitSignal(bearerOpts, {
            type: "t",
            tenantKey: "tk",
            source: "webhook",
            correlationId: "corr-1",
            dedupeKey: "dedupe-1",
            identityClaim: { email: "a@b.c" },
            chatBinding: { chat_id: "c-1" },
            sourceId: "my-source",
        });
        const h = capturedHeaders as unknown as Headers;
        expect(h.get("x-orchid-source")).toBe("my-source");
        expect(h.get("idempotency-key")).toBe("dedupe-1");
    });

    it("maps 401 to OrchidUnauthorizedError", async () => {
        server.use(
            http.post(`${BASE}/signals`, () =>
                HttpResponse.json({ detail: "nope" }, { status: 401 }),
            ),
        );
        await expect(
            client.emitSignal(bearerOpts, { type: "t", tenantKey: "tk" }),
        ).rejects.toBeInstanceOf(OrchidUnauthorizedError);
    });
});

describe("UndiciOrchidAPIClient — getRun / listRuns / listRunsForSignal", () => {
    it("getRun returns a single run by id", async () => {
        server.use(
            http.get(`${BASE}/runs/:id`, () =>
                HttpResponse.json({
                    run_id: "r-1",
                    trigger_id: "tr-1",
                    signal_id: "s-1",
                    agent_name: "basketball",
                    attempt_number: 1,
                    status: "succeeded",
                    visibility: "tenant",
                    queued_at: "2025-01-01T00:00:00Z",
                }),
            ),
        );
        const run = await client.getRun(bearerOpts, "r-1");
        expect(run.run_id).toBe("r-1");
        expect(run.agent_name).toBe("basketball");
        expect(run.status).toBe("succeeded");
    });

    it("listRuns returns runs with optional filters", async () => {
        let seenUrl: string | null = null;
        server.use(
            http.get(`${BASE}/runs`, ({ request }) => {
                seenUrl = request.url;
                return HttpResponse.json({ items: [] });
            }),
        );
        const res = await client.listRuns(bearerOpts, {
            triggerId: "tr-1",
            status: "failed",
            since: "2025-01-01T00:00:00Z",
            limit: 50,
        });
        expect(res.items).toEqual([]);
        const url = new URL(seenUrl as unknown as string);
        expect(url.searchParams.get("trigger_id")).toBe("tr-1");
        expect(url.searchParams.get("status")).toBe("failed");
        expect(url.searchParams.get("since")).toBe("2025-01-01T00:00:00Z");
        expect(url.searchParams.get("limit")).toBe("50");
    });

    it("listRuns sends no query params when filter is empty", async () => {
        let seenUrl: string | null = null;
        server.use(
            http.get(`${BASE}/runs`, ({ request }) => {
                seenUrl = request.url;
                return HttpResponse.json({ items: [] });
            }),
        );
        await client.listRuns(bearerOpts, {});
        expect(seenUrl).toBe(`${BASE}/runs`);
    });

    it("listRunsForSignal filters runs by signal_id client-side", async () => {
        server.use(
            http.get(`${BASE}/runs`, () =>
                HttpResponse.json({
                    items: [
                        {
                            run_id: "r-1",
                            trigger_id: "tr-1",
                            signal_id: "s-1",
                            agent_name: "a",
                            attempt_number: 1,
                            status: "succeeded",
                            visibility: "tenant",
                            queued_at: "t",
                        },
                        {
                            run_id: "r-2",
                            trigger_id: "tr-1",
                            signal_id: "s-2",
                            agent_name: "a",
                            attempt_number: 1,
                            status: "succeeded",
                            visibility: "tenant",
                            queued_at: "t",
                        },
                    ],
                }),
            ),
        );
        const res = await client.listRunsForSignal(bearerOpts, "s-1");
        expect(res.items).toHaveLength(1);
        expect(res.items[0]?.run_id).toBe("r-1");
    });
});

describe("UndiciOrchidAPIClient — empty response body", () => {
    it("handles a 2xx response with empty body (parsed = null)", async () => {
        server.use(http.get(`${BASE}/chats`, () => new HttpResponse(null, { status: 200 })));
        await expect(client.listChats(bearerOpts)).rejects.toBeInstanceOf(OrchidResponseShapeError);
    });
});

describe("UndiciOrchidAPIClient — close()", () => {
    it("is callable and idempotent", async () => {
        await client.close();
        await client.close();
    });
});
