/**
 * Per-method circuit breakers around an :class:`OrchidAPIClient`.
 *
 * Each method gets its own :class:`opossum` breaker because the failure
 * characteristics are different — ``sendMessage`` legitimately blocks
 * for a minute on multi-agent runs, while ``listChats`` should return in
 * milliseconds. Bundling them behind one breaker would let a slow
 * send-message stream trip the breaker for fast list calls.
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

type AnyBreaker = CircuitBreaker<unknown[], unknown>;

/**
 * Wraps an :class:`OrchidAPIClient` behind a circuit breaker per method.
 */
export class CircuitBreakerOrchidAPIClient implements OrchidAPIClient {
    private readonly inner: OrchidAPIClient;
    private readonly breakers: Record<string, AnyBreaker> = {};

    constructor(deps: Deps) {
        this.inner = deps.inner;
        const cfg: CircuitBreakerConfig = { ...defaultCircuitBreakerConfig, ...deps.config };
        const options: CircuitBreaker.Options = {
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
        const register = (name: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
            const breaker = new CircuitBreaker<unknown[], unknown>(fn, options);
            breaker.on("open", () => {
                deps.logger.warn({ method: name }, "circuit breaker opened");
            });
            breaker.on("halfOpen", () => {
                deps.logger.info({ method: name }, "circuit breaker half-open");
            });
            breaker.on("close", () => {
                deps.logger.info({ method: name }, "circuit breaker closed");
            });
            this.breakers[name] = breaker;
        };

        register("createChat", (...args) =>
            this.inner.createChat(...(args as [CallOptions, string?])),
        );
        register("listChats", (...args) => this.inner.listChats(...(args as [CallOptions])));
        register("getMessages", (...args) =>
            this.inner.getMessages(
                ...(args as [CallOptions, string, number | undefined, number | undefined]),
            ),
        );
        register("sendMessage", (...args) =>
            this.inner.sendMessage(
                ...(args as [CallOptions, string, string, FileAttachment[] | undefined]),
            ),
        );
        register("resume", (...args) =>
            this.inner.resume(...(args as [CallOptions, string, boolean])),
        );
        register("upload", (...args) =>
            this.inner.upload(...(args as [CallOptions, string, FileAttachment[]])),
        );
    }

    private async fire<R>(method: string, args: unknown[]): Promise<R> {
        const breaker = this.breakers[method];
        if (breaker === undefined) {
            throw new OrchidGatewayError(`Unknown circuit-breaker method "${method}"`);
        }
        try {
            return (await breaker.fire(...args)) as R;
        } catch (err) {
            if (isBreakerOpenError(err)) {
                throw new OrchidGatewayError(
                    `Upstream circuit breaker open for ${method} — Orchid appears to be down or slow. ` +
                        "The gateway is failing fast to avoid piling up requests.",
                );
            }
            throw err;
        }
    }

    createChat(opts: CallOptions, title?: string): Promise<ChatSession> {
        return this.fire("createChat", [opts, title]);
    }
    listChats(opts: CallOptions): Promise<ChatSession[]> {
        return this.fire("listChats", [opts]);
    }
    getMessages(
        opts: CallOptions,
        chatId: string,
        limit?: number,
        offset?: number,
    ): Promise<ChatMessage[]> {
        return this.fire("getMessages", [opts, chatId, limit, offset]);
    }
    sendMessage(
        opts: CallOptions,
        chatId: string,
        message: string,
        files?: FileAttachment[],
    ): Promise<SendResult> {
        return this.fire("sendMessage", [opts, chatId, message, files]);
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
        return this.fire("resume", [opts, chatId, approved]);
    }
    upload(opts: CallOptions, chatId: string, files: FileAttachment[]): Promise<UploadResponse> {
        return this.fire("upload", [opts, chatId, files]);
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
        for (const b of Object.values(this.breakers)) {
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

