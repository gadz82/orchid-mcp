/**
 * Typed wrapper over the ``orchid-api`` endpoints the gateway needs.
 *
 * Zod schemas here are the single source of truth for response shapes —
 * if ``orchid-api`` changes them, parse failures surface a clear error
 * rather than silently propagating garbage. See the upstream Pydantic
 * models at :file:`orchid-api/orchid_api/models.py`.
 */

import { z } from "zod";

export interface CallOptions {
    bearer: string;
    /** Maps to the ``x-auth-domain`` header upstream. */
    authDomain?: string;
    /** Optional correlation id propagated as ``X-Request-ID``. */
    requestId?: string;
}

export interface FileAttachment {
    filename: string;
    content: Buffer;
    mimeType?: string;
}

/* ── Response schemas ────────────────────────────────────────── */

export const ChatSessionSchema = z.object({
    id: z.string(),
    title: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    is_shared: z.boolean(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const MessageSchema = z.object({
    id: z.string(),
    role: z.string(),
    content: z.string(),
    agents_used: z.array(z.string()),
    created_at: z.string(),
});
export type ChatMessage = z.infer<typeof MessageSchema>;

export const ChatResponseSchema = z.object({
    response: z.string(),
    chat_id: z.string(),
    tenant_id: z.string(),
    agents_used: z.array(z.string()).default([]),
    auth_required: z.array(z.string()).default([]),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/**
 * Mirrors ``orchid_api.models.ToolApprovalRequest`` — ``args`` and
 * ``interrupt_id`` are the real field names (not ``question`` /
 * ``approval_token`` which appeared in an early draft of the plan).
 */
export const ToolApprovalRequestSchema = z.object({
    tool: z.string(),
    args: z.record(z.unknown()).default({}),
    agent: z.string().default(""),
    interrupt_id: z.string().default(""),
});
export type ToolApprovalRequest = z.infer<typeof ToolApprovalRequestSchema>;

export const InterruptResponseSchema = z.object({
    chat_id: z.string(),
    tenant_id: z.string(),
    status: z.literal("interrupted"),
    approvals_needed: z.array(ToolApprovalRequestSchema),
});
export type InterruptResponse = z.infer<typeof InterruptResponseSchema>;

export const SendResultSchema = z.union([ChatResponseSchema, InterruptResponseSchema]);
export type SendResult = z.infer<typeof SendResultSchema>;

export const UploadResponseSchema = z.object({
    status: z.string(),
    files: z.array(
        z.union([
            z.object({ filename: z.string(), chunks_indexed: z.number().int().nonnegative() }),
            z.object({ filename: z.string(), error: z.string() }),
        ]),
    ),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

/* ── Streaming (Phase 9) ─────────────────────────────────────── */

/**
 * SSE event shapes emitted by ``orchid-api``'s
 * ``POST /chats/{id}/messages/stream`` endpoint.
 *
 * Mirrors :file:`orchid-api/orchid_api/routers/streaming.py`. Unknown
 * event types are logged + skipped by the consumer so upstream
 * additions don't break the gateway.
 */
export const StreamTokenEventSchema = z.object({
    type: z.literal("token"),
    content: z.string(),
});
export const StreamStatusEventSchema = z.object({
    type: z.literal("status"),
    agent: z.string(),
    status: z.string(),
    preview: z.string().optional(),
});
export const StreamDoneEventSchema = z.object({
    type: z.literal("done"),
    response: z.string(),
    agents_used: z.array(z.string()).default([]),
    agent_results: z.record(z.string()).default({}),
    auth_required: z.array(z.string()).default([]),
});
export const StreamErrorEventSchema = z.object({
    type: z.literal("error"),
    message: z.string(),
});
export const StreamEventSchema = z.discriminatedUnion("type", [
    StreamTokenEventSchema,
    StreamStatusEventSchema,
    StreamDoneEventSchema,
    StreamErrorEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type StreamTokenEvent = z.infer<typeof StreamTokenEventSchema>;
export type StreamStatusEvent = z.infer<typeof StreamStatusEventSchema>;
export type StreamDoneEvent = z.infer<typeof StreamDoneEventSchema>;
export type StreamErrorEvent = z.infer<typeof StreamErrorEventSchema>;

export interface StreamHandlers {
    /** Called per SSE frame — non-fatal errors here must NOT kill the stream. */
    onEvent: (event: StreamEvent) => void | Promise<void>;
    /** Optional abort signal for co-operative cancellation. */
    signal?: AbortSignal;
}

/* ── MCP gateway exposure config (Phase γ — Oct 2025 feature) ─── */

/**
 * Mirror of orchid-api's ``OrchidMCPGatewayConfig`` response shape.
 * Integrators customise tool titles/descriptions + publish MCP Prompts
 * via this channel; the gateway fetches it at each MCP session init.
 */
export const GatewayToolOverrideSchema = z.object({
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
});

export const GatewayPromptArgumentSchema = z.object({
    name: z.string(),
    description: z.string().nullable().optional(),
    required: z.boolean().default(false),
});

export const GatewayPromptSchema = z.object({
    name: z.string(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    arguments: z.array(GatewayPromptArgumentSchema).default([]),
    template: z.string(),
});

export const GatewayConfigSchema = z.object({
    tools: z.record(GatewayToolOverrideSchema).default({}),
    prompts: z.array(GatewayPromptSchema).default([]),
});

export type GatewayToolOverride = z.infer<typeof GatewayToolOverrideSchema>;
export type GatewayPromptArgument = z.infer<typeof GatewayPromptArgumentSchema>;
export type GatewayPrompt = z.infer<typeof GatewayPromptSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/* ── Auth info (public posture probe, unauthenticated) ────────── */

/**
 * Upstream-OAuth discovery block returned by ``GET /auth-info`` when
 * an :class:`OrchidAuthConfigProvider` is wired on the orchid-api
 * side.  Mirrors :class:`orchid_ai.OrchidUpstreamOAuthConfig`.
 *
 * Contains **only non-secret** values — endpoints, public client_id,
 * advertised scopes.  Never includes ``client_secret`` or any
 * user-scoped tokens; the secret lives on the server that runs the
 * actual token exchange (today that's orchid-mcp itself; Phase 2
 * moves the secret to orchid-api).
 */
export const AuthInfoOAuthSchema = z.object({
    issuer_url: z.string().url(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    client_id: z.string(),
    userinfo_endpoint: z.string().url().nullable().optional(),
    scope: z.string().default(""),
    /**
     * Platform domain (e.g. ``mytenant.example.com``) the gateway
     * should attach as ``X-Auth-Domain`` on every request to
     * orchid-api.  Distinct from the user's email domain — for a
     * single-tenant deployment this is a deploy-time constant.
     * When absent, the gateway falls back to email-domain derivation,
     * which is correct for OIDC IdPs but wrong for any non-OIDC
     * upstream where the tenant host differs from the user's email
     * domain.
     */
    auth_domain: z.string().nullable().optional(),
    /**
     * Dotted JSON path to the ``sub`` claim in a non-OIDC userinfo
     * response. Example: ``"data.user_id"`` when the upstream wraps
     * its payload under a ``data`` key.  Missing / null means "the
     * endpoint returns standard OIDC top-level ``sub``".
     */
    userinfo_sub_path: z.string().nullable().optional(),
    /** Companion to ``userinfo_sub_path`` for the email claim. */
    userinfo_email_path: z.string().nullable().optional(),
    /**
     * When ``true``, orchid-api exposes a server-side
     * ``POST /auth/exchange-code`` endpoint and the gateway should
     * POST the upstream authorization code there rather than calling
     * the upstream ``token_endpoint`` directly.  Phase 2 of the
     * auth-centralisation roadmap — the gateway becomes a public
     * PKCE-only client and drops its copy of ``client_secret``.
     */
    exchange_via_api: z.boolean().optional().default(false),
    /**
     * When ``true``, orchid-api exposes a server-side
     * ``POST /auth/resolve-identity`` endpoint.  The gateway stops
     * hitting the upstream ``userinfo_endpoint`` itself on
     * ``/oauth/callback`` and delegates identity resolution to
     * orchid-api — which runs the same
     * :class:`OrchidIdentityResolver` that validates every
     * authenticated MCP request.  Phase 4 of the auth-centralisation
     * roadmap — drops the last piece of upstream-specific config
     * (userinfo URL + JSON-path hints) from the gateway.
     */
    resolve_via_api: z.boolean().optional().default(false),
    /**
     * When ``true``, orchid-api exposes ``POST /auth/refresh-token``
     * and the gateway POSTs upstream refresh tokens there instead
     * of hitting the upstream ``token_endpoint`` with
     * ``grant_type=refresh_token`` directly.  Phase 4 complement to
     * :attr:`exchange_via_api` — when both are enabled, the gateway
     * never holds ``client_secret``.
     */
    refresh_via_api: z.boolean().optional().default(false),
});
export type AuthInfoOAuth = z.infer<typeof AuthInfoOAuthSchema>;

/**
 * Shape of orchid-api's ``POST /auth/exchange-code`` response.
 * Mirrors RFC 6749 §5.1 — forwarded from the upstream IdP by
 * :class:`orchid_ai.OrchidAuthExchangeClient`.
 */
export const UpstreamTokenResponseSchema = z.object({
    access_token: z.string().min(1),
    token_type: z.string().default("Bearer"),
    refresh_token: z.string().optional(),
    expires_in: z.number().int().optional(),
    scope: z.string().optional(),
});
export type UpstreamTokenResponse = z.infer<typeof UpstreamTokenResponseSchema>;

export interface ExchangeAuthorizationCodeParams {
    code: string;
    redirect_uri: string;
    code_verifier?: string;
}

export interface RefreshUpstreamTokenParams {
    refresh_token: string;
}

/**
 * Shape of orchid-api's ``POST /auth/resolve-identity`` response.
 * Mirrors :class:`orchid_api.routers.auth_identity.ResolveIdentityResponse`.
 * The gateway projects ``subject`` / ``bearer`` / ``auth_domain`` onto
 * its :type:`OrchidIdentity`; ``email`` and ``extra`` are returned for
 * logging and future extensions.
 */
export const ResolveIdentityResponseSchema = z.object({
    subject: z.string().min(1),
    bearer: z.string().min(1),
    auth_domain: z.string().default(""),
    email: z.string().default(""),
    extra: z.record(z.unknown()).default({}),
});
export type ResolveIdentityResponse = z.infer<typeof ResolveIdentityResponseSchema>;

export interface ResolveIdentityParams {
    access_token: string;
    /**
     * Operator-level default domain lives on orchid-api
     * (``settings.auth_domain``); the gateway only passes this when
     * it has a better hint (typically the ``auth_domain`` from
     * ``/auth-info`` discovery — matches the ``X-Auth-Domain`` it
     * would have sent in pre-Phase-4 days).
     */
    auth_domain?: string;
}

/**
 * Shape of ``GET /auth-info`` on orchid-api.  Exposes only
 * non-secret posture plus optional upstream-OAuth discovery:
 *   - ``dev_bypass`` / ``identity_resolver_configured`` — consumer
 *     gateways use this to validate their own auth-mode against the
 *     upstream at startup (see :mod:`src/auth/upstreamPosture.ts`).
 *   - ``oauth`` — present when the operator has wired an
 *     :class:`OrchidAuthConfigProvider` in ``orchid.yml``.  Downstream
 *     OAuth clients (this gateway, Next.js frontends) consume it to
 *     auto-configure endpoints + public ``client_id`` without
 *     duplicating env vars.
 */
export const AuthInfoSchema = z.object({
    dev_bypass: z.boolean(),
    identity_resolver_configured: z.boolean(),
    oauth: AuthInfoOAuthSchema.nullable().optional(),
});
export type AuthInfo = z.infer<typeof AuthInfoSchema>;

/* ── Per-server OAuth authorize URL (enrichment for auth_required) ── */

/**
 * Shape of ``GET /mcp/auth/servers/{name}/authorize`` on orchid-api.
 * Gateway calls this when a :class:`ChatResponse` returns non-empty
 * ``auth_required`` so the host LLM can surface a clickable OAuth
 * link to the user.
 */
export const McpServerAuthorizeSchema = z.object({
    authorize_url: z.string().url(),
    state: z.string(),
});
export type McpServerAuthorize = z.infer<typeof McpServerAuthorizeSchema>;

/* ── Client contract ─────────────────────────────────────────── */

/**
 * All upstream orchid-api calls the gateway makes, as a narrow interface.
 *
 * Implementations are swappable (real undici-backed client in Phase 2,
 * fake in-memory client in tests). Tool handlers depend on this
 * interface, never on the concrete class.
 */
/**
 * Lifecycle hook every concrete client must support — split out so
 * implementations can advertise it independently.
 */
export interface OrchidClientLifecycle {
    close(): Promise<void>;
}

/**
 * Chat-domain operations: create/list/get + send/stream/resume/upload.
 * Tool handlers that only ever speak to the chat surface depend on this
 * interface alone, never on the full :class:`OrchidAPIClient`.
 */
export interface OrchidChatClient {
    createChat(opts: CallOptions, title?: string): Promise<ChatSession>;
    listChats(opts: CallOptions): Promise<ChatSession[]>;
    getMessages(
        opts: CallOptions,
        chatId: string,
        limit?: number,
        offset?: number,
    ): Promise<ChatMessage[]>;
    sendMessage(
        opts: CallOptions,
        chatId: string,
        message: string,
        files?: FileAttachment[],
    ): Promise<SendResult>;
    /**
     * Streaming counterpart to :meth:`sendMessage`. Opens an SSE
     * connection to the upstream streaming endpoint and fans each
     * parsed event out via ``handlers.onEvent``. Resolves with the
     * final ``StreamDoneEvent`` payload; throws on stream error or
     * when the upstream emits a ``StreamErrorEvent``.
     */
    sendMessageStream(
        opts: CallOptions,
        chatId: string,
        message: string,
        files: FileAttachment[] | undefined,
        handlers: StreamHandlers,
    ): Promise<StreamDoneEvent>;
    resume(opts: CallOptions, chatId: string, approved: boolean): Promise<SendResult>;
    upload(opts: CallOptions, chatId: string, files: FileAttachment[]): Promise<UploadResponse>;
}

/**
 * Auth-related operations: posture probe, authorize URL fetch, code
 * exchange, identity resolution, refresh-token grant. Anything that
 * needs to negotiate with the upstream IdP through orchid-api lives
 * here.
 */
export interface OrchidAuthClient {
    /**
     * Fetch orchid-api's public auth posture — **unauthenticated**,
     * no bearer required.  Used at gateway startup to validate that
     * ``ORCHID_MCP_AUTH_MODE`` matches the upstream's requirements.
     */
    getAuthInfo(): Promise<AuthInfo>;
    /**
     * Fetch the OAuth authorization URL for a per-user MCP server
     * (``ChatResponse.auth_required`` entry).  Returns the URL + state
     * so the gateway can surface a clickable link to the host LLM.
     */
    getMcpServerAuthorizeUrl(
        opts: CallOptions,
        serverName: string,
    ): Promise<McpServerAuthorize>;
    /**
     * Proxy an upstream-OAuth ``grant_type=authorization_code``
     * exchange through orchid-api's ``POST /auth/exchange-code``.
     *
     * Phase 2: the gateway doesn't hold ``client_secret`` any more;
     * orchid-api does.  The gateway posts ``{code, redirect_uri,
     * code_verifier}`` and gets back the same token shape the upstream
     * ``token_endpoint`` would have returned.  When discovery
     * advertises ``exchange_via_api=false``, the gateway falls back to
     * calling the upstream directly with its own secret copy —
     * preserves Phase 1 behaviour for operators who haven't migrated.
     */
    exchangeAuthorizationCode(
        opts: CallOptions,
        params: ExchangeAuthorizationCodeParams,
    ): Promise<UpstreamTokenResponse>;
    /**
     * Resolve an upstream access token into an identity payload via
     * orchid-api's ``/auth/resolve-identity`` — unauthenticated on
     * the server side (the token itself is the proof of identity).
     * Used by the Phase-4 :class:`ApiDelegatingResolver` so the
     * gateway no longer needs its own ``userinfo_endpoint`` +
     * JSON-path configuration.
     */
    resolveIdentity(params: ResolveIdentityParams): Promise<ResolveIdentityResponse>;
    /**
     * Refresh an upstream access token via orchid-api's
     * ``POST /auth/refresh-token``.  Shares the response shape with
     * :meth:`exchangeAuthorizationCode` — RFC 6749 §5.1 normalises
     * the code and refresh grant responses.  Phase 4 complement:
     * when ``refresh_via_api=true`` in discovery, the gateway
     * drops its copy of ``client_secret`` entirely.
     */
    refreshUpstreamToken(
        opts: CallOptions,
        params: RefreshUpstreamTokenParams,
    ): Promise<UpstreamTokenResponse>;
}

/**
 * Per-session gateway exposure config (tool overrides + MCP prompts).
 */
export interface OrchidGatewayConfigClient {
    /**
     * Fetch the resolved :type:`GatewayConfig` — tool/prompt overrides
     * the integrator has configured via ``agents.yaml``, env vars, or
     * a prompts file. Called once per MCP session in :mod:`server`.
     */
    getGatewayConfig(opts: CallOptions): Promise<GatewayConfig>;
}

/**
 * Combined client surface implemented by the concrete HTTP clients
 * (:class:`UndiciOrchidAPIClient`, :class:`CircuitBreakerOrchidAPIClient`,
 * any future fake in-memory client in tests). Tool handlers that only
 * touch a slice of the surface should depend on the narrower interfaces
 * (:class:`OrchidChatClient`, :class:`OrchidAuthClient`,
 * :class:`OrchidGatewayConfigClient`) instead.
 */
export interface OrchidAPIClient
    extends OrchidChatClient,
        OrchidAuthClient,
        OrchidGatewayConfigClient,
        OrchidClientLifecycle {}
