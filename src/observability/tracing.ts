/**
 * OpenTelemetry bootstrap.
 *
 * Opt-in — :func:`startTracing` is a no-op unless the operator has set
 * ``OTEL_EXPORTER_OTLP_ENDPOINT`` or ``ORCHID_MCP_TRACING_ENABLED``.
 *
 * The gateway code always calls :func:`withToolSpan` — when tracing is
 * disabled the MCP SDK's registered no-op tracer returns no-op spans, so
 * there's no branch in the hot path.
 */

import {
    SpanStatusCode,
    context as otelContext,
    trace,
    type Attributes,
    type Span,
    type Tracer,
} from "@opentelemetry/api";

import type { Logger } from "./logger.js";

const TRACER_NAME = "orchid-mcp";
const TRACER_VERSION = "0.1.0";

let sdkInstance: { shutdown: () => Promise<void> } | null = null;

export interface StartTracingOptions {
    /** Defaults to ``"orchid-mcp"``. */
    serviceName?: string;
    /** When ``undefined``, tracing stays off. */
    otlpEndpoint?: string;
    logger?: Logger;
}

/**
 * Initialise tracing. Idempotent — calling twice is a no-op on the
 * second call. Exposes :func:`shutdownTracing` for graceful shutdown.
 */
export async function startTracing(opts: StartTracingOptions): Promise<void> {
    if (sdkInstance !== null) return;
    const endpoint = opts.otlpEndpoint;
    if (endpoint === undefined || endpoint.length === 0) {
        opts.logger?.info("tracing disabled (no OTEL_EXPORTER_OTLP_ENDPOINT)");
        return;
    }

    // Dynamic imports — these packages pull in heavy transitive deps, so
    // keep them out of the cold path when tracing is off.
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http").catch(
        () => ({ OTLPTraceExporter: null }),
    );
    const { UndiciInstrumentation } = await import(
        "@opentelemetry/instrumentation-undici"
    ).catch(() => ({ UndiciInstrumentation: null }));

    const sdkConfig: Record<string, unknown> = {
        serviceName: opts.serviceName ?? TRACER_NAME,
    };
    if (OTLPTraceExporter !== null) {
        sdkConfig.traceExporter = new OTLPTraceExporter({ url: endpoint });
    }
    if (UndiciInstrumentation !== null) {
        sdkConfig.instrumentations = [new UndiciInstrumentation()];
    }
    const sdk = new NodeSDK(sdkConfig as ConstructorParameters<typeof NodeSDK>[0]);

    sdk.start();
    sdkInstance = { shutdown: () => sdk.shutdown() };
    opts.logger?.info({ endpoint }, "tracing enabled");
}

export async function shutdownTracing(): Promise<void> {
    if (sdkInstance === null) return;
    try {
        await sdkInstance.shutdown();
    } finally {
        sdkInstance = null;
    }
}

export function getTracer(): Tracer {
    return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

/**
 * Wrap ``fn`` in a tool-scope span. When tracing is disabled the span is
 * a no-op — no allocation overhead beyond the function call.
 */
export async function withToolSpan<T>(
    name: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    const tracer = getTracer();
    return tracer.startActiveSpan(name, { attributes }, async (span: Span) => {
        try {
            const result = await fn(span);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        } catch (err) {
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
            });
            if (err instanceof Error) {
                span.recordException(err);
            }
            throw err;
        } finally {
            span.end();
        }
    });
}

export { otelContext };
