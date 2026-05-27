/**
 * Phase-7 tests for the three Pollen + Bloom MCP tools.
 *
 * Each test wires a minimal :class:`AppContext` with a fake events
 * client, drives the tool's body via ``runWithTooling``-equivalent
 * registration, and asserts on the structured-content shape and
 * the upstream call recorded by the fake.  No msw — the
 * ``OrchidEventsClient`` interface lives at exactly the right
 * granularity for a hand-rolled fake.
 */

import { describe, expect, it } from "vitest";

import type { AuthStrategy, MCPRequestContext, OrchidIdentity } from "../src/auth/base.js";
import { SHARED_SUBJECT } from "../src/auth/serviceAccount.js";
import type { AppContext } from "../src/context.js";
import { OrchidGatewayError, OrchidServerError } from "../src/errors.js";
import type {
    BloomRun,
    BloomRunListResponse,
    CallOptions,
    EmitSignalParams,
    ListRunsFilter,
    OrchidAPIClient,
    SignalEmitResponse,
} from "../src/http/orchidClient.js";
import { createLogger } from "../src/observability/logger.js";
import { NoopRateLimiter } from "../src/rateLimit.js";
import { MemorySessionMap } from "../src/sessions/memory.js";
import {
    bloomListInputShape,
    bloomStatusInputShape,
    registerBloomListTool,
    registerBloomStatusTool,
    registerSignalEmitTool,
    signalEmitInputShape,
} from "../src/tools/eventsTools.js";

import { eventsNoop } from "./_helpers/stubEvents.js";

class StubAuthStrategy implements AuthStrategy {
    readonly mode = "service_account" as const;
    identity: OrchidIdentity = { bearer: "tok", subject: SHARED_SUBJECT };
    async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
        return this.identity;
    }
}

interface RecordedEmit {
    opts: CallOptions;
    params: EmitSignalParams;
}

interface RecordedList {
    opts: CallOptions;
    filter: ListRunsFilter;
}

interface RecordedListForSignal {
    opts: CallOptions;
    signalId: string;
}

interface RecordedGet {
    opts: CallOptions;
    runId: string;
}

class FakeEventsClient implements OrchidAPIClient {
    emitSignalResult: SignalEmitResponse = {
        signal_id: "sig-default",
        deduplicated: false,
    };
    emitSignalCalls: RecordedEmit[] = [];
    listRunsCalls: RecordedList[] = [];
    listRunsResult: BloomRunListResponse = { items: [] };
    listRunsForSignalCalls: RecordedListForSignal[] = [];
    listRunsForSignalResult: BloomRunListResponse | Error = { items: [] };
    getRunCalls: RecordedGet[] = [];
    getRunResult: BloomRun | Error = {
        run_id: "r-default",
        trigger_id: "t-default",
        signal_id: "s-default",
        agent_name: "agent",
        attempt_number: 1,
        status: "succeeded",
        visibility: "actor",
        visibility_user_id: "u-1",
        queued_at: "2026-05-07T10:00:00+00:00",
    };

    /* ── events surface ─────────────────────── */
    async emitSignal(opts: CallOptions, params: EmitSignalParams): Promise<SignalEmitResponse> {
        this.emitSignalCalls.push({ opts, params });
        return this.emitSignalResult;
    }
    async getRun(opts: CallOptions, runId: string): Promise<BloomRun> {
        this.getRunCalls.push({ opts, runId });
        if (this.getRunResult instanceof Error) throw this.getRunResult;
        return this.getRunResult;
    }
    async listRuns(opts: CallOptions, filter: ListRunsFilter): Promise<BloomRunListResponse> {
        this.listRunsCalls.push({ opts, filter });
        return this.listRunsResult;
    }
    async listRunsForSignal(opts: CallOptions, signalId: string): Promise<BloomRunListResponse> {
        this.listRunsForSignalCalls.push({ opts, signalId });
        if (this.listRunsForSignalResult instanceof Error) throw this.listRunsForSignalResult;
        return this.listRunsForSignalResult;
    }

    /* ── chat surface (unused — throw to flag accidental calls) ── */
    async createChat(): Promise<never> {
        throw new Error("createChat not used in events tests");
    }
    async listChats(): Promise<never> {
        throw new Error("listChats not used in events tests");
    }
    async getMessages(): Promise<never> {
        throw new Error("getMessages not used in events tests");
    }
    async sendMessage(): Promise<never> {
        throw new Error("sendMessage not used in events tests");
    }
    async sendMessageStream(): Promise<never> {
        throw new Error("sendMessageStream not used in events tests");
    }
    async resume(): Promise<never> {
        throw new Error("resume not used in events tests");
    }
    async upload(): Promise<never> {
        throw new Error("upload not used in events tests");
    }

    async getGatewayConfig(): Promise<{ tools: Record<string, never>; prompts: never[] }> {
        return { tools: {}, prompts: [] };
    }
    async getAuthInfo(): Promise<{
        dev_bypass: boolean;
        identity_resolver_configured: boolean;
    }> {
        return { dev_bypass: true, identity_resolver_configured: false };
    }
    async getMcpServerAuthorizeUrl(): Promise<{ authorize_url: string; state: string }> {
        throw new Error("getMcpServerAuthorizeUrl not used in events tests");
    }
    async exchangeAuthorizationCode(): Promise<{ access_token: string; token_type: string }> {
        throw new Error("exchangeAuthorizationCode not used in events tests");
    }
    async resolveIdentity(): Promise<{
        subject: string;
        bearer: string;
        auth_domain: string;
        email: string;
        extra: Record<string, unknown>;
    }> {
        throw new Error("resolveIdentity not used in events tests");
    }
    async refreshUpstreamToken(): Promise<{ access_token: string; token_type: string }> {
        throw new Error("refreshUpstreamToken not used in events tests");
    }
    async close(): Promise<void> {
        /* noop */
    }
}

function makeCtx(client?: FakeEventsClient) {
    const httpClient = client ?? new FakeEventsClient();
    const sessionMap = new MemorySessionMap({ ttlSeconds: 60 });
    const ctx: AppContext = {
        settings: {} as AppContext["settings"],
        logger: createLogger("silent"),
        httpClient,
        sessionMap,
        authStrategy: new StubAuthStrategy(),
        rateLimiter: new NoopRateLimiter(),
    };
    return { ctx, httpClient };
}

/**
 * Tiny in-process MCP server stand-in that captures the registration
 * callbacks so the tests can drive the handlers directly without
 * spinning up an HTTP transport.  Mirrors the shape used in
 * ``eventsTools.ts`` — only ``registerTool`` is needed.
 */
class CapturingServer {
    handlers: Record<
        string,
        (
            args: unknown,
            extra: unknown,
        ) => Promise<{
            isError?: boolean;
            content: { type: string; text: string }[];
            structuredContent?: Record<string, unknown>;
        }>
    > = {};

    registerTool(
        name: string,
        _meta: unknown,
        handler: (
            args: unknown,
            extra: unknown,
        ) => Promise<{
            isError?: boolean;
            content: { type: string; text: string }[];
            structuredContent?: Record<string, unknown>;
        }>,
    ): { update: () => void } {
        this.handlers[name] = handler;
        return { update: () => undefined };
    }
}

const extra = { sessionId: "sess-1", requestInfo: { headers: {} } };

/* ── orchid_signal_emit ─────────────────────────────────────── */

describe("orchid_signal_emit", () => {
    it("emits a signal with the bearer + tenant + dedupe key threaded through", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.emitSignalResult = {
            signal_id: "sig-42",
            deduplicated: false,
        };
        const server = new CapturingServer();
        registerSignalEmitTool(
            server as unknown as Parameters<typeof registerSignalEmitTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_signal_emit!(
            {
                type: "support.ticket.created",
                tenant_key: "acme-prod",
                payload: { ticket_id: "T-1" },
                user_id: "u-7",
                dedupe_key: "T-1:created",
            },
            extra,
        );
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({
            kind: "signal_emitted",
            signal_id: "sig-42",
            deduplicated: false,
        });
        expect(httpClient.emitSignalCalls).toHaveLength(1);
        const call = httpClient.emitSignalCalls[0]!;
        expect(call.opts.bearer).toBe("tok");
        expect(call.params).toEqual({
            type: "support.ticket.created",
            tenantKey: "acme-prod",
            payload: { ticket_id: "T-1" },
            userId: "u-7",
            dedupeKey: "T-1:created",
        });
    });

    it("flags deduplicated emissions in the structured payload", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.emitSignalResult = {
            signal_id: "sig-99",
            deduplicated: true,
        };
        const server = new CapturingServer();
        registerSignalEmitTool(
            server as unknown as Parameters<typeof registerSignalEmitTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_signal_emit!(
            { type: "demo", tenant_key: "t-1" },
            extra,
        );
        expect((result.structuredContent as { deduplicated: boolean }).deduplicated).toBe(true);
        expect(result.content[0]?.text).toContain("duplicate");
    });

    it("surfaces upstream errors as isError tool results", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.emitSignal = async () => {
            throw new OrchidServerError("boom", 422, { detail: "bad payload" });
        };
        const server = new CapturingServer();
        registerSignalEmitTool(
            server as unknown as Parameters<typeof registerSignalEmitTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_signal_emit!(
            { type: "demo", tenant_key: "t-1" },
            extra,
        );
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("422");
    });

    it("zod schema rejects empty type", () => {
        const parsed = signalEmitInputShape.type.safeParse("");
        expect(parsed.success).toBe(false);
    });
});

/* ── orchid_bloom_status ────────────────────────────────────── */

describe("orchid_bloom_status", () => {
    it("rejects calls with neither signal_id nor run_id", async () => {
        const { ctx } = makeCtx();
        const server = new CapturingServer();
        registerBloomStatusTool(
            server as unknown as Parameters<typeof registerBloomStatusTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_bloom_status!({}, extra);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("exactly one");
    });

    it("rejects calls with both signal_id and run_id", async () => {
        const { ctx } = makeCtx();
        const server = new CapturingServer();
        registerBloomStatusTool(
            server as unknown as Parameters<typeof registerBloomStatusTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_bloom_status!(
            { signal_id: "s", run_id: "r" },
            extra,
        );
        expect(result.isError).toBe(true);
    });

    it("looks up by run_id and renders the run summary", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.getRunResult = {
            run_id: "r-1",
            trigger_id: "morning-trivia",
            signal_id: "sig-1",
            agent_name: "notifications",
            attempt_number: 1,
            status: "succeeded",
            visibility: "tenant",
            queued_at: "2026-05-07T07:00:00+00:00",
            finished_at: "2026-05-07T07:00:01+00:00",
            result: { final_response: "## Trivia\n- Fact A" },
        };
        const server = new CapturingServer();
        registerBloomStatusTool(
            server as unknown as Parameters<typeof registerBloomStatusTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_bloom_status!({ run_id: "r-1" }, extra);
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as { kind: string; latest_run: { status: string } };
        expect(sc.kind).toBe("bloom_status");
        expect(sc.latest_run.status).toBe("succeeded");
        expect(httpClient.getRunCalls).toEqual([{ opts: { bearer: "tok" }, runId: "r-1" }]);
    });

    it("looks up by signal_id and returns the latest run", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.listRunsForSignalResult = {
            items: [
                {
                    run_id: "r-2",
                    trigger_id: "ticket-triage",
                    signal_id: "sig-z",
                    agent_name: "support",
                    attempt_number: 2,
                    status: "succeeded",
                    visibility: "actor",
                    visibility_user_id: "u-1",
                    queued_at: "2026-05-07T08:00:00+00:00",
                },
                {
                    run_id: "r-1",
                    trigger_id: "ticket-triage",
                    signal_id: "sig-z",
                    agent_name: "support",
                    attempt_number: 1,
                    status: "failed",
                    visibility: "actor",
                    visibility_user_id: "u-1",
                    queued_at: "2026-05-07T07:30:00+00:00",
                },
            ],
        };
        const server = new CapturingServer();
        registerBloomStatusTool(
            server as unknown as Parameters<typeof registerBloomStatusTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_bloom_status!({ signal_id: "sig-z" }, extra);
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as {
            signal_id: string;
            latest_run: { run_id: string; attempt_number: number };
        };
        expect(sc.signal_id).toBe("sig-z");
        expect(sc.latest_run.run_id).toBe("r-2"); // first item == most recent
        expect(httpClient.listRunsForSignalCalls).toEqual([
            { opts: { bearer: "tok" }, signalId: "sig-z" },
        ]);
    });

    it("returns latest_run=null when no runs are visible for the signal", async () => {
        const { ctx } = makeCtx();
        const server = new CapturingServer();
        registerBloomStatusTool(
            server as unknown as Parameters<typeof registerBloomStatusTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_bloom_status!(
            { signal_id: "no-runs-yet" },
            extra,
        );
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as { latest_run: unknown };
        expect(sc.latest_run).toBeNull();
        expect(result.content[0]?.text).toContain("No Bloom runs are visible");
    });

    it("surfaces upstream 404 (e.g. visibility-filtered) as a clean error", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.getRun = async () => {
            throw new OrchidServerError("not found", 404, { detail: "not found" });
        };
        const server = new CapturingServer();
        registerBloomStatusTool(
            server as unknown as Parameters<typeof registerBloomStatusTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_bloom_status!({ run_id: "secret" }, extra);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("404");
    });

    it("zod schema accepts run_id alone OR signal_id alone", () => {
        expect(bloomStatusInputShape.run_id.safeParse("r-1").success).toBe(true);
        expect(bloomStatusInputShape.signal_id.safeParse("s-1").success).toBe(true);
    });
});

/* ── orchid_bloom_list ──────────────────────────────────────── */

describe("orchid_bloom_list", () => {
    it("forwards filters to listRuns and returns structured items", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.listRunsResult = {
            items: [
                {
                    run_id: "r-1",
                    trigger_id: "weekly-digest",
                    signal_id: "s-1",
                    agent_name: "digest",
                    attempt_number: 1,
                    status: "succeeded",
                    visibility: "addressed",
                    visibility_user_id: "u-alice",
                    queued_at: "2026-05-07T06:00:00+00:00",
                },
            ],
        };
        const server = new CapturingServer();
        registerBloomListTool(
            server as unknown as Parameters<typeof registerBloomListTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_bloom_list!(
            {
                trigger_id: "weekly-digest",
                status: "succeeded",
                since: "2026-05-07T00:00:00+00:00",
                limit: 50,
            },
            extra,
        );
        expect(result.isError).toBeFalsy();
        expect(httpClient.listRunsCalls).toEqual([
            {
                opts: { bearer: "tok" },
                filter: {
                    triggerId: "weekly-digest",
                    status: "succeeded",
                    since: "2026-05-07T00:00:00+00:00",
                    limit: 50,
                },
            },
        ]);
        const sc = result.structuredContent as { count: number; items: BloomRun[] };
        expect(sc.count).toBe(1);
        expect(sc.items[0]?.run_id).toBe("r-1");
    });

    it("returns a friendly message when no runs match", async () => {
        const { ctx } = makeCtx();
        const server = new CapturingServer();
        registerBloomListTool(
            server as unknown as Parameters<typeof registerBloomListTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_bloom_list!({}, extra);
        expect(result.isError).toBeFalsy();
        expect(result.content[0]?.text).toContain("No Bloom runs match");
    });

    it("surfaces gateway errors as isError", async () => {
        const { ctx, httpClient } = makeCtx();
        httpClient.listRuns = async () => {
            throw new OrchidGatewayError("upstream unreachable");
        };
        const server = new CapturingServer();
        registerBloomListTool(
            server as unknown as Parameters<typeof registerBloomListTool>[0],
            ctx,
        );
        const result = await server.handlers.orchid_bloom_list!({}, extra);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("upstream unreachable");
    });

    it("zod schema clamps limit to [1, 500]", () => {
        expect(bloomListInputShape.limit.safeParse(0).success).toBe(false);
        expect(bloomListInputShape.limit.safeParse(501).success).toBe(false);
        expect(bloomListInputShape.limit.safeParse(50).success).toBe(true);
    });
});

/* ── eventsNoop helper sanity ───────────────────────────────── */

describe("eventsNoop helper", () => {
    it("throws a descriptive NotImplementedError when called", async () => {
        const stub = eventsNoop();
        await expect(
            stub.emitSignal({ bearer: "" }, { type: "x", tenantKey: "t" }),
        ).rejects.toThrow(/not implemented/);
    });
});
