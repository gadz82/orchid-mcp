/**
 * Concrete :class:`OrchidAPIClient` backed by Node 20's **global**
 * ``fetch`` (which is ``undici`` bundled inside Node itself).
 *
 * Historical note: Phase 7 tried to use ``undici@7`` with a custom
 * :class:`undici.Agent` dispatcher for connection pooling + finer
 * ``headersTimeout`` / ``bodyTimeout``.  That produced a subtle
 * incompatibility — ``new FormData()`` returns Node's bundled undici-6
 * ``FormData`` class, but the ``undici@7`` installed via npm shipped a
 * different ``FormData`` and refused to serialise the Node instance
 * as multipart, sending an empty body to ``POST /chats/…/messages``
 * (orchid-api returned 422 on the missing ``message`` field).
 *
 * Fix: use Node's global ``fetch``.  We lose a bit of Agent-level
 * pool control but keep ``AbortSignal.timeout`` for per-request
 * timeouts and gain internal ``FormData`` compatibility.  Connection
 * pooling still works via Node's default global agent.
 *
 * The client auto-attaches an ``X-Request-ID`` header from the current
 * correlation context when the caller hasn't explicitly passed one.
 */

import { z } from "zod";

import {
    OrchidGatewayError,
    OrchidResponseShapeError,
    OrchidServerError,
    OrchidTimeoutError,
    OrchidUnauthorizedError,
} from "../errors.js";
import { getRequestId } from "../observability/correlation.js";

import {
    AuthInfoSchema,
    ChatSessionSchema,
    GatewayConfigSchema,
    McpServerAuthorizeSchema,
    MessageSchema,
    ResolveIdentityResponseSchema,
    SendResultSchema,
    StreamEventSchema,
    UploadResponseSchema,
    UpstreamTokenResponseSchema,
    type AuthInfo,
    type CallOptions,
    type ChatMessage,
    type ChatSession,
    type ExchangeAuthorizationCodeParams,
    type FileAttachment,
    type GatewayConfig,
    type McpServerAuthorize,
    type OrchidAPIClient,
    type RefreshUpstreamTokenParams,
    type ResolveIdentityParams,
    type ResolveIdentityResponse,
    type UpstreamTokenResponse,
    type SendResult,
    type StreamDoneEvent,
    type StreamHandlers,
    type UploadResponse,
} from "./orchidClient.js";
import { parseSSE } from "./sseParser.js";

export interface UndiciOrchidAPIClientOptions {
    baseUrl: string;
    timeoutMs: number;
    /** Optional override for tests that want to bypass the Agent. */
    fetchImpl?: typeof fetch;
}

interface RequestSpec {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: string | FormData;
    contentType?: string;
}

export class UndiciOrchidAPIClient implements OrchidAPIClient {
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: UndiciOrchidAPIClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/$/, "");
        this.timeoutMs = opts.timeoutMs;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    async createChat(opts: CallOptions, title?: string): Promise<ChatSession> {
        const body = JSON.stringify({ title: title ?? "" });
        const raw = await this.perform(opts, {
            method: "POST",
            path: "/chats",
            body,
            contentType: "application/json",
        });
        return this.parse(ChatSessionSchema, raw);
    }

    async listChats(opts: CallOptions): Promise<ChatSession[]> {
        const raw = await this.perform(opts, { method: "GET", path: "/chats" });
        return this.parse(z.array(ChatSessionSchema), raw);
    }

    async getMessages(
        opts: CallOptions,
        chatId: string,
        limit = 50,
        offset = 0,
    ): Promise<ChatMessage[]> {
        const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        const raw = await this.perform(opts, {
            method: "GET",
            path: `/chats/${encodeURIComponent(chatId)}/messages?${qs.toString()}`,
        });
        return this.parse(z.array(MessageSchema), raw);
    }

    async sendMessage(
        opts: CallOptions,
        chatId: string,
        message: string,
        files: FileAttachment[] = [],
    ): Promise<SendResult> {
        const form = buildMultipart(message, files);
        const raw = await this.perform(opts, {
            method: "POST",
            path: `/chats/${encodeURIComponent(chatId)}/messages`,
            body: form,
        });
        return this.parse(SendResultSchema, raw);
    }

    async sendMessageStream(
        opts: CallOptions,
        chatId: string,
        message: string,
        files: FileAttachment[] | undefined,
        handlers: StreamHandlers,
    ): Promise<StreamDoneEvent> {
        const form = buildMultipart(message, files ?? []);
        const url = `${this.baseUrl}/chats/${encodeURIComponent(chatId)}/messages/stream`;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${opts.bearer}`,
            Accept: "text/event-stream",
        };
        if (opts.authDomain !== undefined) {
            headers["x-auth-domain"] = opts.authDomain;
        }
        const requestId = opts.requestId ?? getRequestId();
        if (requestId !== undefined) {
            headers["X-Request-ID"] = requestId;
        }

        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method: "POST",
                headers,
                body: form,
                ...(handlers.signal !== undefined ? { signal: handlers.signal } : {}),
            });
        } catch (err) {
            if (isTimeoutLike(err)) {
                throw new OrchidTimeoutError(
                    `Upstream streaming connection timed out: POST ${url}`,
                );
            }
            throw new OrchidGatewayError(
                `Upstream streaming request failed (POST ${url}): ${errorMessage(err)}`,
            );
        }

        if (response.status === 401 || response.status === 403) {
            throw new OrchidUnauthorizedError(
                `Upstream rejected credentials on streaming: ${String(response.status)}`,
            );
        }
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new OrchidServerError(
                `Upstream returned ${String(response.status)} on streaming request`,
                response.status,
                body,
            );
        }
        if (response.body === null) {
            throw new OrchidResponseShapeError("Upstream streaming response had no body");
        }

        let doneEvent: StreamDoneEvent | null = null;
        let errorMessageText: string | null = null;

        for await (const raw of parseSSE(response.body)) {
            if (raw.data.length === 0) continue;
            let json: unknown;
            try {
                json = JSON.parse(raw.data);
            } catch {
                // Tolerate malformed frames — log level is handled by the caller.
                continue;
            }
            const parsed = StreamEventSchema.safeParse(json);
            if (!parsed.success) {
                // Unknown event shape — forward-compatible: skip.
                continue;
            }
            await handlers.onEvent(parsed.data);
            if (parsed.data.type === "done") {
                doneEvent = parsed.data;
            } else if (parsed.data.type === "error") {
                errorMessageText = parsed.data.message;
            }
        }

        if (errorMessageText !== null) {
            throw new OrchidGatewayError(`Upstream streaming error: ${errorMessageText}`);
        }
        if (doneEvent === null) {
            throw new OrchidResponseShapeError(
                "Upstream streaming ended without a 'done' event",
            );
        }
        return doneEvent;
    }

    async resume(opts: CallOptions, chatId: string, approved: boolean): Promise<SendResult> {
        const body = JSON.stringify({ approved });
        const raw = await this.perform(opts, {
            method: "POST",
            path: `/chats/${encodeURIComponent(chatId)}/resume`,
            body,
            contentType: "application/json",
        });
        return this.parse(SendResultSchema, raw);
    }

    async upload(
        opts: CallOptions,
        chatId: string,
        files: FileAttachment[],
    ): Promise<UploadResponse> {
        if (files.length === 0) {
            throw new OrchidGatewayError("upload() requires at least one file");
        }
        const form = new FormData();
        for (const file of files) {
            form.append("files", toBlob(file), file.filename);
        }
        const raw = await this.perform(opts, {
            method: "POST",
            path: `/chats/${encodeURIComponent(chatId)}/upload`,
            body: form,
        });
        return this.parse(UploadResponseSchema, raw);
    }

    async getGatewayConfig(opts: CallOptions): Promise<GatewayConfig> {
        const raw = await this.perform(opts, { method: "GET", path: "/mcp-gateway/config" });
        return this.parse(GatewayConfigSchema, raw);
    }

    async getMcpServerAuthorizeUrl(
        opts: CallOptions,
        serverName: string,
    ): Promise<McpServerAuthorize> {
        const raw = await this.perform(opts, {
            method: "GET",
            path: `/mcp/auth/servers/${encodeURIComponent(serverName)}/authorize`,
        });
        return this.parse(McpServerAuthorizeSchema, raw);
    }

    async exchangeAuthorizationCode(
        opts: CallOptions,
        params: ExchangeAuthorizationCodeParams,
    ): Promise<UpstreamTokenResponse> {
        // Goes through the standard ``perform()`` path so tracing +
        // correlation + 4xx/5xx mapping all behave like every other
        // upstream call.  Endpoint is intentionally unauthenticated
        // on the server side — PKCE + upstream code verification
        // provide the protection.  We still send ``opts.bearer``
        // when present; orchid-api ignores it but it doesn't hurt.
        const payload: Record<string, string> = {
            code: params.code,
            redirect_uri: params.redirect_uri,
        };
        if (params.code_verifier !== undefined) {
            payload.code_verifier = params.code_verifier;
        }
        const raw = await this.perform(opts, {
            method: "POST",
            path: "/auth/exchange-code",
            body: JSON.stringify(payload),
            contentType: "application/json",
        });
        return this.parse(UpstreamTokenResponseSchema, raw);
    }

    async refreshUpstreamToken(
        opts: CallOptions,
        params: RefreshUpstreamTokenParams,
    ): Promise<UpstreamTokenResponse> {
        // Same posture as :meth:`exchangeAuthorizationCode` — the
        // endpoint is unauthenticated (the refresh token is itself
        // the bearer credential).  Route through ``perform`` so the
        // correlation / tracing / error-mapping machinery applies
        // uniformly.
        const payload: Record<string, string> = {
            refresh_token: params.refresh_token,
        };
        const raw = await this.perform(opts, {
            method: "POST",
            path: "/auth/refresh-token",
            body: JSON.stringify(payload),
            contentType: "application/json",
        });
        return this.parse(UpstreamTokenResponseSchema, raw);
    }

    async resolveIdentity(
        params: ResolveIdentityParams,
    ): Promise<ResolveIdentityResponse> {
        // Unauthenticated on the server side — same posture as
        // ``/auth/exchange-code``.  We still route through the
        // standard ``perform()`` path for tracing + correlation +
        // 4xx/5xx mapping, sending an empty bearer so ``perform``'s
        // Authorization header is a harmless no-op (orchid-api
        // ignores it on this endpoint).
        const payload: Record<string, string> = { access_token: params.access_token };
        if (params.auth_domain !== undefined && params.auth_domain.length > 0) {
            payload.auth_domain = params.auth_domain;
        }
        const raw = await this.perform(
            { bearer: "" },
            {
                method: "POST",
                path: "/auth/resolve-identity",
                body: JSON.stringify(payload),
                contentType: "application/json",
            },
        );
        return this.parse(ResolveIdentityResponseSchema, raw);
    }

    async getAuthInfo(): Promise<AuthInfo> {
        // Unauthenticated — bypass the standard ``perform()`` path that
        // always sends Authorization.  Zod-validated response.
        const url = `${this.baseUrl}/auth-info`;
        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method: "GET",
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            if (isTimeoutLike(err)) {
                throw new OrchidTimeoutError(
                    `Upstream timed out fetching ${url}`,
                );
            }
            throw new OrchidGatewayError(
                `Upstream GET /auth-info failed: ${errorMessage(err)}`,
            );
        }
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new OrchidServerError(
                `Upstream returned ${String(response.status)} on GET /auth-info`,
                response.status,
                body,
            );
        }
        const json = (await response.json()) as unknown;
        return this.parse(AuthInfoSchema, json);
    }

    async close(): Promise<void> {
        // No-op — global fetch has no per-instance resources to release.
    }

    private async perform(opts: CallOptions, req: RequestSpec): Promise<unknown> {
        const url = `${this.baseUrl}${req.path}`;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${opts.bearer}`,
            Accept: "application/json",
        };
        if (opts.authDomain !== undefined) {
            headers["x-auth-domain"] = opts.authDomain;
        }
        const requestId = opts.requestId ?? getRequestId();
        if (requestId !== undefined) {
            headers["X-Request-ID"] = requestId;
        }
        if (req.contentType !== undefined) {
            headers["Content-Type"] = req.contentType;
        }
        // For FormData bodies the Content-Type (with boundary) is set by fetch.

        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method: req.method,
                headers,
                body: req.body ?? null,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            if (isTimeoutLike(err)) {
                const idSuffix = requestId !== undefined ? ` (request id: ${requestId})` : "";
                throw new OrchidTimeoutError(
                    `Upstream timed out after ${this.timeoutMs}ms: ${req.method} ${req.path}${idSuffix}`,
                );
            }
            throw new OrchidGatewayError(
                `Upstream request failed (${req.method} ${req.path}): ${errorMessage(err)}`,
            );
        }

        const text = await response.text();
        const status = response.status;

        let parsed: unknown;
        if (text.length === 0) {
            parsed = null;
        } else {
            try {
                parsed = JSON.parse(text);
            } catch {
                if (status >= 200 && status < 300) {
                    throw new OrchidResponseShapeError(
                        `Non-JSON response body from ${req.method} ${req.path}`,
                    );
                }
                parsed = text;
            }
        }

        if (status === 401 || status === 403) {
            throw new OrchidUnauthorizedError(
                `Upstream rejected credentials: ${status} on ${req.method} ${req.path}`,
            );
        }
        if (status < 200 || status >= 300) {
            throw new OrchidServerError(
                `Upstream returned ${status} on ${req.method} ${req.path}`,
                status,
                parsed,
            );
        }

        return parsed;
    }

    private parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
        const result = schema.safeParse(body);
        if (!result.success) {
            throw new OrchidResponseShapeError(
                `Upstream response shape invalid: ${result.error.message}`,
            );
        }
        return result.data;
    }
}

function buildMultipart(message: string, files: FileAttachment[]): FormData {
    const form = new FormData();
    form.append("message", message);
    for (const file of files) {
        form.append("files", toBlob(file), file.filename);
    }
    return form;
}

function toBlob(file: FileAttachment): Blob {
    return new Blob([file.content], {
        type: file.mimeType ?? "application/octet-stream",
    });
}

export function isTimeoutLike(err: unknown): boolean {
    if (err === null || typeof err !== "object") {
        return false;
    }
    const anyErr = err as { name?: unknown; cause?: { name?: unknown } };
    if (anyErr.name === "AbortError" || anyErr.name === "TimeoutError") {
        return true;
    }
    const cause = anyErr.cause;
    if (
        cause !== null &&
        typeof cause === "object" &&
        (cause.name === "TimeoutError" || cause.name === "AbortError")
    ) {
        return true;
    }
    return false;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
