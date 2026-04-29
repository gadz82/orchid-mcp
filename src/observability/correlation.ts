/**
 * Request-scoped correlation context.
 *
 * AsyncLocalStorage-backed. Tool handlers wrap their body in
 * :func:`withCorrelation`; every :mod:`pino` child logger, upstream HTTP
 * call, and OTEL span inside that scope then carries the same
 * ``requestId`` + ``mcpSessionId`` without threading them through every
 * function signature.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Logger } from "./logger.js";

export interface CorrelationContext {
    requestId: string;
    mcpSessionId: string;
    logger: Logger;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export async function withCorrelation<T>(
    ctx: CorrelationContext,
    fn: () => Promise<T>,
): Promise<T> {
    return storage.run(ctx, fn);
}

export function getCorrelation(): CorrelationContext | undefined {
    return storage.getStore();
}

export function getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
}

export function getCorrelationLogger(): Logger | undefined {
    return storage.getStore()?.logger;
}

export function newRequestId(): string {
    return `req-${randomUUID()}`;
}
