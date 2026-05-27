/**
 * Startup-time consistency check between the gateway's configured
 * ``authMode`` and the upstream orchid-api's auth posture.
 *
 * Reasoning matrix:
 *
 * | upstream dev_bypass | gateway authMode | verdict                                             |
 * |---------------------|------------------|-----------------------------------------------------|
 * | ``true``            | ``service_account`` | OK — token value is ignored upstream.            |
 * | ``true``            | ``oauth``        | OK but wasteful — warn, oauth is heavier than needed. |
 * | ``false``           | ``service_account`` | **FATAL** — upstream will 401 every request.     |
 * | ``false``           | ``oauth``        | OK — standard production path.                      |
 *
 * The fatal case is detected once at gateway startup so the operator
 * sees a clear error instead of every MCP client silently getting 401s
 * on every tool call.
 */

import type { AuthInfo, OrchidAPIClient } from "../http/orchidClient.js";
import { OrchidConfigError, OrchidGatewayError } from "../errors.js";
import type { Logger } from "../observability/logger.js";

export type GatewayAuthMode = "service_account" | "oauth";

export interface PostureVerdict {
    ok: boolean;
    /** Present when ``ok=false`` — an operator-facing error description. */
    error?: string;
    /** Present when ``ok=true`` but the combination is suboptimal. */
    warning?: string;
}

/**
 * Pure function — applies the decision matrix above.  Extracted so the
 * startup sequence stays thin and the logic is trivially testable.
 */
export function evaluateUpstreamPosture(
    authInfo: AuthInfo,
    authMode: GatewayAuthMode,
): PostureVerdict {
    if (!authInfo.dev_bypass && authMode === "service_account") {
        return {
            ok: false,
            error:
                "Upstream orchid-api requires real authentication " +
                "(dev_bypass=false, identity_resolver_configured=" +
                String(authInfo.identity_resolver_configured) +
                ") but orchid-mcp is running in service_account mode. " +
                "The gateway's static token would 401 on every request. " +
                "Set ORCHID_MCP_AUTH_MODE=oauth and configure the OAuth " +
                "endpoint env vars (see README).",
        };
    }
    if (authInfo.dev_bypass && authMode === "oauth") {
        return {
            ok: true,
            warning:
                "Upstream orchid-api is in dev_bypass mode but orchid-mcp " +
                "is configured for oauth — oauth will work, but " +
                "service_account mode would be simpler in this setup.",
        };
    }
    return { ok: true };
}

export interface VerifyOptions {
    /** Maximum number of /auth-info probes before giving up. Default 5. */
    maxAttempts?: number;
    /** Delay between retries in ms. Default 2000. */
    delayMs?: number;
    /** Sleep hook (for tests). */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Probe ``/auth-info`` with retries, then apply :func:`evaluateUpstreamPosture`.
 *
 * - On **fatal verdict**: throws :class:`OrchidConfigError` (process should exit).
 * - On **warning verdict**: logs at WARN level, returns.
 * - On **OK verdict**: logs at INFO, returns.
 * - On **exhausted retries** (upstream unreachable): logs WARN and returns —
 *   startup proceeds; the gateway will surface auth failures per-session
 *   once orchid-api comes up.
 */
export async function verifyUpstreamAuthPosture(
    httpClient: Pick<OrchidAPIClient, "getAuthInfo">,
    authMode: GatewayAuthMode,
    logger: Logger,
    opts: VerifyOptions = {},
): Promise<void> {
    const maxAttempts = opts.maxAttempts ?? 5;
    const delayMs = opts.delayMs ?? 2000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const info = await httpClient.getAuthInfo();
            const verdict = evaluateUpstreamPosture(info, authMode);
            if (!verdict.ok) {
                throw new OrchidConfigError(verdict.error ?? "upstream auth posture mismatch");
            }
            if (verdict.warning !== undefined) {
                logger.warn({ dev_bypass: info.dev_bypass, authMode }, verdict.warning);
            } else {
                logger.info(
                    {
                        dev_bypass: info.dev_bypass,
                        identity_resolver_configured: info.identity_resolver_configured,
                        authMode,
                    },
                    "upstream auth posture verified",
                );
            }
            return;
        } catch (err) {
            if (err instanceof OrchidConfigError) {
                // Config mismatch — bubble up, don't retry.
                throw err;
            }
            lastError = err;
            if (attempt < maxAttempts) {
                logger.debug(
                    { attempt, maxAttempts, err },
                    "upstream /auth-info unreachable — will retry",
                );
                await sleep(delayMs);
            }
        }
    }
    logger.warn(
        { attempts: maxAttempts, err: lastError },
        "could not reach upstream /auth-info at startup — gateway will start; session init may still fail if the config is misaligned",
    );
}

// Re-export for test convenience.
export { OrchidGatewayError };
