/**
 * Per-request context construction for MCP tool handlers.
 *
 * Owns the shape that the SDK passes into a handler (``ToolHandlerExtra``)
 * and the typed adapters that turn it into the gateway's internal
 * :class:`MCPRequestContext` and :class:`CallOptions`. Lives in its own
 * file so handlers and tests can import what they need without dragging
 * in the result-shaping or runWithTooling machinery.
 */

import type { MCPRequestContext, OrchidIdentity } from "../auth/base.js";
import type { CallOptions } from "../http/orchidClient.js";

export interface ToolHandlerExtra {
    sessionId?: string;
    requestInfo?: { headers?: Record<string, string | string[] | undefined> };
    authInfo?: { token?: string };
    /** MCP ``_meta`` — carries ``progressToken`` when the client opted into streaming. */
    _meta?: ({ progressToken?: string | number | undefined } & Record<string, unknown>) | undefined;
    /**
     * Set by the MCP SDK — lets the handler emit ``notifications/progress``.
     * Typed loosely so we accept the SDK's narrow ``ServerNotification`` union
     * (which is stricter than our generic shape).
     */
    sendNotification?: (notification: never) => Promise<void>;
}

/** Narrow shape for the one notification we actually emit. */
export interface ProgressNotification {
    method: "notifications/progress";
    params: {
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
    };
}

/**
 * Wrapper that casts through ``never`` so we can pass our :type:`ProgressNotification`
 * to the SDK's strictly-typed ``sendNotification``. The SDK accepts it at runtime —
 * the union includes ``notifications/progress`` — but the TS types are too narrow
 * to let us construct a union member directly.
 */
export async function emitProgressNotification(
    sendNotification: NonNullable<ToolHandlerExtra["sendNotification"]>,
    notification: ProgressNotification,
): Promise<void> {
    await (sendNotification as unknown as (n: ProgressNotification) => Promise<void>)(
        notification,
    );
}

export function buildRequestContext(extra: ToolHandlerExtra): MCPRequestContext {
    const headers = normalizeHeaders(extra.requestInfo?.headers);
    const ctx: MCPRequestContext = {
        mcpSessionId: extra.sessionId ?? "no-session",
        headers,
    };
    const accessToken = extra.authInfo?.token ?? bearerFromAuthHeader(headers.authorization);
    if (accessToken !== undefined) {
        ctx.accessToken = accessToken;
    }
    return ctx;
}

export function buildCallOptions(identity: OrchidIdentity, requestId?: string): CallOptions {
    const opts: CallOptions = { bearer: identity.bearer };
    if (identity.authDomain !== undefined) {
        opts.authDomain = identity.authDomain;
    }
    if (requestId !== undefined) {
        opts.requestId = requestId;
    }
    return opts;
}

function bearerFromAuthHeader(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!value.toLowerCase().startsWith("bearer ")) return undefined;
    const token = value.slice(7).trim();
    return token.length > 0 ? token : undefined;
}

function normalizeHeaders(
    raw: Record<string, string | string[] | undefined> | undefined,
): Record<string, string> {
    if (raw === undefined) {
        return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (v === undefined) {
            continue;
        }
        const value = Array.isArray(v) ? (v[0] ?? "") : v;
        out[k.toLowerCase()] = value;
    }
    return out;
}
