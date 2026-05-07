/**
 * Pollen + Bloom MCP tools (Phase 7).
 *
 * Three tools the host LLM calls when it wants to drive the Orchid
 * events surface:
 *
 * - ``orchid_signal_emit`` — fire-and-forget signal ingest.
 * - ``orchid_bloom_status`` — resolve a signal id to its latest run +
 *   that run's status / result.
 * - ``orchid_bloom_list``   — paginate recent runs visible to the
 *   caller, optionally filtered by trigger / status / since.
 *
 * Each tool goes through ``runWithTooling`` so correlation ids,
 * spans, and the rate-limiter apply uniformly.  The §26 visibility
 * filter lives upstream — the gateway never re-filters; if the
 * caller's bearer can't see a run, ``orchid_bloom_status`` surfaces
 * a 404 from upstream as a clean ``isError`` result.
 */

import { z } from "zod";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { MCPRequestContext } from "../auth/base.js";
import type { AppContext } from "../context.js";
import type { BloomRun, EmitSignalParams, ListRunsFilter } from "../http/orchidClient.js";
import {
    buildCallOptions,
    errorToResult,
    isErrorResult,
    runWithTooling,
    type ToolHandlerExtra,
} from "./_shared.js";

/* ── orchid_signal_emit ─────────────────────────────────────── */

export const signalEmitInputShape = {
    type: z
        .string()
        .min(1)
        .describe(
            "Signal type (e.g. 'support.ticket.created').  Must match an active trigger upstream.",
        ),
    tenant_key: z
        .string()
        .min(1)
        .describe(
            "Tenant the signal belongs to.  Must match the caller's resolved tenant — orchid-api will reject mismatches.",
        ),
    payload: z
        .record(z.unknown())
        .optional()
        .describe("Opaque event body.  Triggers' JMESPath when: filters select on it."),
    user_id: z
        .string()
        .optional()
        .describe(
            "Originating user id.  Required for ``act_as_user`` and ``addressed_to_user`` flavours.",
        ),
    correlation_id: z
        .string()
        .optional()
        .describe("Correlation id linking related signals across the system."),
    dedupe_key: z
        .string()
        .optional()
        .describe(
            "Idempotency key.  Re-emitting the same (source, dedupe_key) pair is a no-op (returns the original signal_id).",
        ),
    identity_claim: z
        .record(z.unknown())
        .optional()
        .describe(
            "Override for the resolved identity claim (rare).  Defaults to act_as_user with the caller's user_id.",
        ),
    chat_binding: z
        .record(z.unknown())
        .optional()
        .describe(
            "§25 chat binding — pin the resulting Bloom's final AIMessage to a chat the caller owns.  Trigger must opt in via respect_chat_binding=true.",
        ),
} as const;

type SignalEmitInput = z.infer<z.ZodObject<typeof signalEmitInputShape>>;

const SIGNAL_EMIT_TITLE = "Emit a Pollen signal";
const SIGNAL_EMIT_DESCRIPTION =
    "Emit a Pollen + Bloom signal that may trigger one or more background Bloom runs upstream. " +
    "Returns immediately with the persisted signal_id.  Use orchid_bloom_status to track resulting runs.";

export function registerSignalEmitTool(server: McpServer, ctx: AppContext): RegisteredTool {
    return server.registerTool(
        "orchid_signal_emit",
        {
            title: SIGNAL_EMIT_TITLE,
            description: SIGNAL_EMIT_DESCRIPTION,
            inputSchema: signalEmitInputShape,
        },
        async (args, extra: ToolHandlerExtra) =>
            runWithTooling(ctx, "orchid_signal_emit", extra, (reqCtx) =>
                signalEmitImpl(ctx, reqCtx, args),
            ),
    );
}

async function signalEmitImpl(
    ctx: AppContext,
    reqCtx: MCPRequestContext,
    args: SignalEmitInput,
): Promise<CallToolResult> {
    try {
        const identity = await ctx.authStrategy.resolve(reqCtx);
        const callOpts = buildCallOptions(identity);
        const params: EmitSignalParams = {
            type: args.type,
            tenantKey: args.tenant_key,
        };
        if (args.payload !== undefined) params.payload = args.payload;
        if (args.user_id !== undefined) params.userId = args.user_id;
        if (args.correlation_id !== undefined) params.correlationId = args.correlation_id;
        if (args.dedupe_key !== undefined) params.dedupeKey = args.dedupe_key;
        if (args.identity_claim !== undefined) params.identityClaim = args.identity_claim;
        if (args.chat_binding !== undefined) params.chatBinding = args.chat_binding;

        const result = await ctx.httpClient.emitSignal(callOpts, params);
        const human =
            `Signal emitted (signal_id=${result.signal_id})` +
            (result.deduplicated ? " — duplicate of a previously-ingested signal." : ".");
        return {
            content: [{ type: "text", text: human }],
            structuredContent: {
                kind: "signal_emitted",
                signal_id: result.signal_id,
                deduplicated: result.deduplicated,
            },
        };
    } catch (err) {
        return errorToResult(err, ctx, "orchid_signal_emit");
    }
}

/* ── orchid_bloom_status ────────────────────────────────────── */

export const bloomStatusInputShape = {
    signal_id: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Signal id whose latest run you want to inspect.  Mutually exclusive with run_id.",
        ),
    run_id: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Specific run id to inspect.  Mutually exclusive with signal_id.",
        ),
} as const;

type BloomStatusInput = z.infer<z.ZodObject<typeof bloomStatusInputShape>>;

const BLOOM_STATUS_TITLE = "Get Pollen Bloom run status";
const BLOOM_STATUS_DESCRIPTION =
    "Look up the status (and result, when finished) of a Bloom run.  Pass either signal_id (returns the latest " +
    "run for that signal) or run_id (returns that run directly).  Returns 'not_found' when the caller's bearer " +
    "can't see the resource — visibility (§26) is enforced upstream.";

export function registerBloomStatusTool(server: McpServer, ctx: AppContext): RegisteredTool {
    return server.registerTool(
        "orchid_bloom_status",
        {
            title: BLOOM_STATUS_TITLE,
            description: BLOOM_STATUS_DESCRIPTION,
            inputSchema: bloomStatusInputShape,
        },
        async (args, extra: ToolHandlerExtra) =>
            runWithTooling(ctx, "orchid_bloom_status", extra, (reqCtx) =>
                bloomStatusImpl(ctx, reqCtx, args),
            ),
    );
}

async function bloomStatusImpl(
    ctx: AppContext,
    reqCtx: MCPRequestContext,
    args: BloomStatusInput,
): Promise<CallToolResult> {
    if (
        (args.signal_id === undefined) ===
        (args.run_id === undefined)
    ) {
        return isErrorResult(
            "Pass exactly one of signal_id or run_id.",
        );
    }
    try {
        const identity = await ctx.authStrategy.resolve(reqCtx);
        const callOpts = buildCallOptions(identity);

        let run: BloomRun;
        if (args.run_id !== undefined) {
            run = await ctx.httpClient.getRun(callOpts, args.run_id);
        } else {
            const list = await ctx.httpClient.listRunsForSignal(callOpts, args.signal_id!);
            if (list.items.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `No Bloom runs are visible for signal ${args.signal_id}. ` +
                                `Either the trigger hasn't fired yet, the signal was filtered out by the trigger's when: clause, ` +
                                `or the caller's bearer can't see them (§26 visibility).`,
                        },
                    ],
                    structuredContent: {
                        kind: "bloom_status",
                        signal_id: args.signal_id,
                        latest_run: null,
                    },
                };
            }
            // The first item is the most recent (orchid-api orders
            // by queued_at DESC).  Multiple attempts of the same
            // (trigger, signal) pair share signal_id but differ in
            // attempt_number — we surface the highest attempt by
            // letting the upstream's order win.
            run = list.items[0]!;
        }

        return {
            content: [
                {
                    type: "text",
                    text: renderRunSummary(run),
                },
            ],
            structuredContent: {
                kind: "bloom_status",
                signal_id: args.signal_id ?? run.signal_id,
                latest_run: run,
            },
        };
    } catch (err) {
        return errorToResult(err, ctx, "orchid_bloom_status");
    }
}

/* ── orchid_bloom_list ──────────────────────────────────────── */

export const bloomListInputShape = {
    trigger_id: z
        .string()
        .min(1)
        .optional()
        .describe("Filter by trigger id (e.g. 'morning-trivia')."),
    status: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Filter by status (pending / running / succeeded / failed / cancelled / retry_scheduled).",
        ),
    since: z
        .string()
        .optional()
        .describe("ISO8601 timestamp.  Returns runs queued at or after this time."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum runs to return (default 50, cap 500)."),
} as const;

type BloomListInput = z.infer<z.ZodObject<typeof bloomListInputShape>>;

const BLOOM_LIST_TITLE = "List recent Pollen Bloom runs";
const BLOOM_LIST_DESCRIPTION =
    "List recent Bloom runs visible to the caller, optionally filtered by trigger_id / status / since. " +
    "The §26 visibility filter lives upstream — the gateway never re-filters.  Use orchid_bloom_status for full detail.";

export function registerBloomListTool(server: McpServer, ctx: AppContext): RegisteredTool {
    return server.registerTool(
        "orchid_bloom_list",
        {
            title: BLOOM_LIST_TITLE,
            description: BLOOM_LIST_DESCRIPTION,
            inputSchema: bloomListInputShape,
        },
        async (args, extra: ToolHandlerExtra) =>
            runWithTooling(ctx, "orchid_bloom_list", extra, (reqCtx) =>
                bloomListImpl(ctx, reqCtx, args),
            ),
    );
}

async function bloomListImpl(
    ctx: AppContext,
    reqCtx: MCPRequestContext,
    args: BloomListInput,
): Promise<CallToolResult> {
    try {
        const identity = await ctx.authStrategy.resolve(reqCtx);
        const callOpts = buildCallOptions(identity);
        const filter: ListRunsFilter = {};
        if (args.trigger_id !== undefined) filter.triggerId = args.trigger_id;
        if (args.status !== undefined) filter.status = args.status;
        if (args.since !== undefined) filter.since = args.since;
        if (args.limit !== undefined) filter.limit = args.limit;

        const list = await ctx.httpClient.listRuns(callOpts, filter);
        const summary = list.items.length === 0
            ? "No Bloom runs match the filter."
            : list.items.map(renderRunOneLine).join("\n");

        return {
            content: [{ type: "text", text: summary }],
            structuredContent: {
                kind: "bloom_run_list",
                items: list.items,
                count: list.items.length,
            },
        };
    } catch (err) {
        return errorToResult(err, ctx, "orchid_bloom_list");
    }
}

/* ── Helpers ───────────────────────────────────────────────── */

function renderRunSummary(run: BloomRun): string {
    const lines = [
        `Run ${run.run_id} (trigger ${run.trigger_id})`,
        `  status:         ${run.status}`,
        `  agent:          ${run.agent_name}`,
        `  attempt:        ${String(run.attempt_number)}`,
        `  visibility:     ${run.visibility}` + (run.visibility_user_id !== undefined && run.visibility_user_id !== null ? ` (user ${run.visibility_user_id})` : ""),
        `  queued_at:      ${run.queued_at}`,
    ];
    if (run.started_at !== undefined && run.started_at !== null) {
        lines.push(`  started_at:     ${run.started_at}`);
    }
    if (run.finished_at !== undefined && run.finished_at !== null) {
        lines.push(`  finished_at:    ${run.finished_at}`);
    }
    if (run.error !== undefined && run.error !== null && run.error.length > 0) {
        lines.push(`  error:          ${run.error}`);
    }
    if (run.result !== undefined && run.result !== null) {
        const json = typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2);
        lines.push("  result:");
        lines.push(json.split("\n").map((l) => `    ${l}`).join("\n"));
    }
    return lines.join("\n");
}

function renderRunOneLine(run: BloomRun): string {
    return `${run.run_id}  ${run.status.padEnd(10)}  ${run.trigger_id.padEnd(24)}  ${run.queued_at}`;
}
