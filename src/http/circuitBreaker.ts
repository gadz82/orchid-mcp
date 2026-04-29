/**
 * Per-method circuit breakers around an :class:`OrchidAPIClient`.
 *
 * Each method gets its own :class:`opossum` breaker because the failure
 * characteristics are different — ``sendMessage`` legitimately blocks
 * for a minute on multi-agent runs, while ``listChats`` should return in
 * milliseconds. Bundling them behind one breaker would let a slow
 * send-message stream trip the breaker for fast list calls.
 *
 * Wrapping is typed end-to-end: ``wrap(fn)`` returns a function with
 * the same call signature as ``fn`` (no ``unknown[]`` / ``string``
 * indirection), so a typo in a forwarded call is a TypeScript error,
 * not a runtime ``OrchidGatewayError("unknown method")``.
 */

import CircuitBreaker from "opossum";

import { OrchidGatewayError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import type {
    AuthInfo,
    CallOptions,
    ChatMessage,
    ChatSession,
    ExchangeAuthorizationCodeParams,
    FileAttachment,
    GatewayConfig,
    McpServerAuthorize,
    OrchidAPIClient,
    RefreshUpstreamTokenParams,
    ResolveIdentityParams,
    ResolveIdentityResponse,
    SendResult,
    StreamDoneEvent,
    StreamHandlers,
    UploadResponse,
    UpstreamTokenResponse,
} from "./orchidClient.js";

export interface CircuitBreakerConfig {
    /** Percentage of failures in the rolling window that trips the breaker. */
    errorThresholdPercentage: number;
    /** How long the breaker stays open before a half-open probe. */
    resetTimeoutMs: number;
    /** Size of the statistics rolling window. */
    rollingWindowMs: number;
}

export const defaultCircuitBreakerConfig: CircuitBreakerConfig = {
    errorThresholdPercentage: 50,
    resetTimeoutMs: 30_000,
    rollingWindowMs: 10_000,
};

interface Deps {
    inner: OrchidAPIClient;
    logger: Logger;
    config?: Partial<CircuitBreakerConfig>;
}

/** A registered breaker — only used for lifecycle ``shutdown()``. */
type AnyBreaker = CircuitBreaker<unknown[], unknown>;

/** Generic shape for a method we wrap. */
type AsyncFn<Args extends unknown[], R> = (...args: Args) => Promise<R>;

/**
 * Wraps an :class:`OrchidAPIClient` behind a circuit breaker per method.
 */
export class CircuitBreakerOrchidAPIClient implements OrchidAPIClient {
    private readonly inner: OrchidAPIClient;
    private readonly breakers: AnyBreaker[] = [];
    private readonly logger: Logger;
    private readonly options: CircuitBreaker.Options;

    private readonly _createChat: OrchidAPIClient["createChat"];
    private readonly _listChats: OrchidAPIClient["listChats"];
    private readonly _getMessages: OrchidAPIClient["getMessages"];
    private readonly _sendMessage: OrchidAPIClient["sendMessage"];
    private readonly _resume: OrchidAPIClient["resume"];
    private readonly _upload: OrchidAPIClient["upload"];

    constructor(deps: Deps) {
        this.inner = deps.inner;
        this.logger = deps.logger;
        const cfg: CircuitBreakerConfig = { ...defaultCircuitBreakerConfig, ...deps.config };
        this.options = {
            errorThresholdPercentage: cfg.errorThresholdPercentage,
            resetTimeout: cfg.resetTimeoutMs,
            rollingCountTimeout: cfg.rollingWindowMs,
            rollingCountBuckets: 10,
            timeout: false,
            capacity: Number.POSITIVE_INFINITY,
            // volumeThreshold: 0 (default) — a single failure in a bucket is
            // sufficient to trip the breaker if errorThresholdPercentage is met.
            // We deliberately do NOT set allowWarmUp: it suppresses opening
            // during startup, which hides real outages.
        };

        this._createChat = this.wrap("createChat", this.inner.createChat.bind(this.inner));
        this._listChats = this.wrap("listChats", this.inner.listChats.bind(this.inner));
        this._getMessages = this.wrap("getMessages", this.inner.getMessages.bind(this.inner));
        this._sendMessage = this.wrap("sendMessage", this.inner.sendMessage.bind(this.inner));
        this._resume = this.wrap("resume", this.inner.resume.bind(this.inner));
        this._upload = this.wrap("upload", this.inner.upload.bind(this.inner));
    }

    /**
     * Wrap one client method behind a breaker, preserving its
     * call signature. Mistakes in the forwarded call surface as
     * TypeScript errors at compile time, not as ``Unknown method``
     * runtime exceptions.
     */
    private wrap<Args extends unknown[], R>(
        name: string,
        fn: AsyncFn<Args, R>,
    ): AsyncFn<Args, R> {
        const breaker = new CircuitBreaker<Args, R>(fn, this.options);
        breaker.on("open", () => {
            this.logger.warn({ method: name }, "circuit breaker opened");
        });
        breaker.on("halfOpen", () => {
            this.logger.info({ method: name }, "circuit breaker half-open");
        });
        breaker.on("close", () => {
            this.logger.info({ method: name }, "circuit breaker closed");
        });
        this.breakers.push(breaker as AnyBreaker);
        return (async (...args: Args): Promise<R> => {
            try {
                return await breaker.fire(...args);
            } catch (err) {
                if (isBreakerOpenError(err)) {
                    throw new OrchidGatewayError(
                        `Upstream circuit breaker open for ${name} — Orchid appears to be down or slow. ` +
                            "The gateway is failing fast to avoid piling up requests.",
                    );
                }
                throw err;
            }
        }) as AsyncFn<Args, R>;
    }

    createChat(opts: CallOptions, title?: string): Promise<ChatSession> {
        return this._createChat(opts, title);
    }
    listChats(opts: CallOptions): Promise<ChatSession[]> {
        return this._listChats(opts);
    }
    getMessages(
        opts: CallOptions,
        chatId: string,
        limit?: number,
        offset?: number,
    ): Promise<ChatMessage[]> {
        return this._getMessages(opts, chatId, limit, offset);
    }
    sendMessage(
        opts: CallOptions,
        chatId: string,
        message: string,
        files?: FileAttachment[],
    ): Promise<SendResult> {
        return this._sendMessage(opts, chatId, message, files);
    }
    /**
     * Streaming calls bypass the circuit breaker intentionally — their
     * long-lived semantics don't fit the rolling error-rate model
     * ``opossum`` uses; a single 60-second multi-agent run that errors
     * mid-stream would distort the stats for fast list/get calls. The
     * non-streaming ``sendMessage`` remains breaker-wrapped, so the
     * cluster-wide health signal is preserved.
     */
    sendMessageStream(
        opts: CallOptions,
        chatId: string,
        message: string,
        files: FileAttachment[] | undefined,
        handlers: StreamHandlers,
    ): Promise<StreamDoneEvent> {
        return this.inner.sendMessageStream(opts, chatId, message, files, handlers);
    }
    resume(opts: CallOptions, chatId: string, approved: boolean): Promise<SendResult> {
        return this._resume(opts, chatId, approved);
    }
    upload(opts: CallOptions, chatId: string, files: FileAttachment[]): Promise<UploadResponse> {
        return this._upload(opts, chatId, files);
    }
    /**
     * Bypasses the breaker — this is a one-shot config fetch at session
     * init, not a user-triggered request; folding it into the same
     * failure budget as real tool calls would skew stats.
     */
    getGatewayConfig(opts: CallOptions): Promise<GatewayConfig> {
        return this.inner.getGatewayConfig(opts);
    }
    /** Bypasses the breaker — one-shot startup probe, not user traffic. */
    getAuthInfo(): Promise<AuthInfo> {
        return this.inner.getAuthInfo();
    }
    /**
     * Bypasses the breaker — a rare enrichment call made only when a
     * ``ChatResponse`` has a non-empty ``auth_required`` list. Upstream
     * failures degrade the enrichment but must never block the tool
     * result from returning, so the breaker is deliberately skipped.
     */
    getMcpServerAuthorizeUrl(
        opts: CallOptions,
        serverName: string,
    ): Promise<McpServerAuthorize> {
        return this.inner.getMcpServerAuthorizeUrl(opts, serverName);
    }
    /**
     * Bypasses the breaker — OAuth code exchange happens once per
     * user login.  A breaker opening mid-login would strand the user
     * on the IdP callback page with no way to recover except waiting
     * for the breaker to heal.  We prefer a hard upstream error that
     * surfaces as a clean 502 on the gateway's ``/oauth/callback``.
     */
    exchangeAuthorizationCode(
        opts: CallOptions,
        params: ExchangeAuthorizationCodeParams,
    ): Promise<UpstreamTokenResponse> {
        return this.inner.exchangeAuthorizationCode(opts, params);
    }
    /**
     * Bypasses the breaker — single call per user login (like
     * ``exchangeAuthorizationCode``).  A breaker opening mid-login
     * would strand the user on the callback page with no recovery
     * path except waiting for the rolling window to heal.  Cleaner
     * to let upstream failures surface as a 502 on ``/oauth/callback``.
     */
    resolveIdentity(params: ResolveIdentityParams): Promise<ResolveIdentityResponse> {
        return this.inner.resolveIdentity(params);
    }
    /**
     * Bypasses the breaker — refresh calls happen at gateway
     * token-rotation time (every hour by default).  An open breaker
     * here would silently degrade every user's session to
     * re-authentication; we prefer a clean upstream error so the
     * failure is visible and bounded per-user.
     */
    refreshUpstreamToken(
        opts: CallOptions,
        params: RefreshUpstreamTokenParams,
    ): Promise<UpstreamTokenResponse> {
        return this.inner.refreshUpstreamToken(opts, params);
    }
    close(): Promise<void> {
        // Shut down every breaker so their internal timers don't keep the
        // event loop alive.
        for (const b of this.breakers) {
            b.shutdown();
        }
        return this.inner.close();
    }
}

function isBreakerOpenError(err: unknown): boolean {
    if (err === null || typeof err !== "object") return false;
    const anyErr = err as { code?: unknown; message?: unknown };
    if (anyErr.code === "EOPENBREAKER") return true;
    return typeof anyErr.message === "string" && anyErr.message === "Breaker is open";
}
