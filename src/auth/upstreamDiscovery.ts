/**
 * Upstream-OAuth discovery — fetches orchid-api's ``/auth-info``
 * endpoint and merges its ``oauth`` block into the gateway's settings.
 *
 * Rationale.  Operators running the Orchid stack used to configure the
 * same upstream-OAuth endpoints (issuer, authorization, token,
 * userinfo, public client id, scopes) in three places:
 *
 *   1. ``orchid.yml`` on the orchid-api side (via an
 *      :class:`OrchidAuthConfigProvider` consumer implementation).
 *   2. The MCP gateway's env vars (``ORCHID_MCP_OAUTH_*``).
 *   3. The Next.js frontends' env vars (``OAUTH_*``,
 *      consumer-prefixed equivalents, …).
 *
 * Drift between the three was a real source of production issues.
 * ``discover`` mode collapses (1) into the canonical source and lets
 * (2) and (3) consume it at startup over HTTP.  The gateway still
 * holds its own ``client_secret`` locally in this phase — the secret
 * never travels over ``/auth-info`` (see :mod:`orchid_ai.core.auth_config`).
 */

import type { Settings } from "../settings.js";
import type { AuthInfo, AuthInfoOAuth } from "../http/orchidClient.js";
import type { Logger } from "../observability/logger.js";
import { OrchidConfigError } from "../errors.js";

export interface DiscoveryRetryOptions {
    /** Max total attempts before giving up. Defaults to 5. */
    maxAttempts?: number;
    /** Delay between attempts, in ms. Defaults to 2000. */
    delayMs?: number;
    /** Overridable sleep for tests. */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Minimal interface a client must satisfy to support discovery.
 *
 * Keeping it narrow lets tests pass a bare-bones object without
 * implementing the full :class:`OrchidAPIClient` surface.
 */
export interface AuthInfoFetcher {
    getAuthInfo(): Promise<AuthInfo>;
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch ``/auth-info`` with retries.  Returns the full :type:`AuthInfo`
 * payload so the caller can inspect posture (dev_bypass /
 * identity_resolver_configured) alongside the oauth block.
 */
export async function fetchAuthInfoWithRetries(
    client: AuthInfoFetcher,
    logger: Logger,
    opts: DiscoveryRetryOptions = {},
): Promise<AuthInfo> {
    const maxAttempts = opts.maxAttempts ?? 5;
    const delayMs = opts.delayMs ?? 2_000;
    const sleep = opts.sleep ?? defaultSleep;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await client.getAuthInfo();
        } catch (err) {
            lastErr = err;
            if (attempt === maxAttempts) break;
            logger.warn(
                { err, attempt, maxAttempts },
                "failed to fetch /auth-info — retrying",
            );
            await sleep(delayMs);
        }
    }
    throw new OrchidConfigError(
        `Discovery failed: could not fetch /auth-info from upstream after ` +
            `${String(maxAttempts)} attempts. Last error: ` +
            `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
}

/**
 * Merge a discovered ``oauth`` block into the gateway settings.
 *
 * Precedence: **env vars win**.  Any ``ORCHID_MCP_OAUTH_*`` value the
 * operator explicitly set in the environment takes priority over the
 * discovered value — this keeps a smooth migration path and lets a
 * deployment override one specific field (e.g. temporarily pointing
 * to a staging token endpoint) without having to reconfigure the
 * entire stack.
 *
 * ``client_secret`` is NEVER sourced from discovery — it's strictly an
 * env-var-owned secret on the gateway side in this phase.
 */
export function mergeDiscoveredOAuthSettings(
    settings: Settings,
    oauth: AuthInfoOAuth,
): Settings {
    const merged: Settings = {
        ...settings,
        oauthIssuerUrl: settings.oauthIssuerUrl ?? oauth.issuer_url,
        oauthAuthorizationEndpoint:
            settings.oauthAuthorizationEndpoint ?? oauth.authorization_endpoint,
        oauthClientId: settings.oauthClientId ?? oauth.client_id,
    };
    // Platform domain for X-Auth-Domain — env-var override still wins.
    if (merged.oauthAuthDomain === undefined && oauth.auth_domain) {
        merged.oauthAuthDomain = oauth.auth_domain;
    }
    // ``token_endpoint`` / ``userinfo_endpoint`` /
    // ``userinfo_sub_path`` / ``userinfo_email_path`` /
    // ``exchange_via_api`` / ``resolve_via_api`` /
    // ``refresh_via_api`` are still part of the
    // :type:`AuthInfoOAuth` schema for downstream consumers (e.g.
    // ``orchid-frontend``) but the gateway no longer reads them —
    // Phase 5 retired the legacy direct-to-IdP code paths, so the
    // gateway's behaviour is "always centralise" regardless of
    // what the flags say.

    // Scopes: env-var wins even over a discovered value, but the
    // settings default (``"openid profile email"``) shouldn't beat a
    // real upstream scope.  We treat the settings default as "not
    // customised" and let discovery override it.  Callers explicitly
    // setting ``ORCHID_MCP_OAUTH_SCOPES`` to anything else win.
    const scopesFromSettingsLookLikeDefault =
        settings.oauthScopes === "openid profile email";
    if (scopesFromSettingsLookLikeDefault && oauth.scope.length > 0) {
        merged.oauthScopes = oauth.scope;
    }
    return merged;
}

/**
 * Apply discovery to ``settings`` when in ``discover`` mode.
 *
 * - Fetches ``/auth-info`` via the provided client (with retries).
 * - Validates that the upstream actually returned an oauth block.
 * - Merges the discovered values into ``settings`` (env-var overrides win).
 * - Returns ``{settings, authMode: "oauth"}`` so the downstream
 *   ``buildAuthStrategy`` flow treats the result identically to a
 *   fully env-configured OAuth deployment.
 *
 * Callers invoke this only when ``settings.authMode === "discover"``;
 * other modes pass through unchanged.
 */
export async function applyUpstreamDiscovery(
    settings: Settings,
    client: AuthInfoFetcher,
    logger: Logger,
    opts: DiscoveryRetryOptions = {},
): Promise<Settings> {
    if (settings.authMode !== "discover") return settings;

    const authInfo = await fetchAuthInfoWithRetries(client, logger, opts);
    if (!authInfo.oauth) {
        throw new OrchidConfigError(
            "Upstream /auth-info did not return an ``oauth`` block — the " +
                "orchid-api side has no OrchidAuthConfigProvider wired. " +
                "Either configure ``auth.auth_config_provider_class`` in " +
                "orchid.yml, or switch ORCHID_MCP_AUTH_MODE away from " +
                "``discover``.",
        );
    }
    if (authInfo.oauth.client_id.length === 0) {
        throw new OrchidConfigError(
            "Upstream /auth-info returned an empty ``oauth.client_id`` — " +
                "the orchid-api provider resolved discovery but the " +
                "underlying env var (the one named in the consumer's " +
                "``auth.oauth_client_id_env`` setting) is not set on the " +
                "orchid-api side. Fix there, then restart the gateway.",
        );
    }
    const merged = mergeDiscoveredOAuthSettings(settings, authInfo.oauth);
    logger.info(
        {
            issuer: merged.oauthIssuerUrl,
            clientId: merged.oauthClientId,
            scopes: merged.oauthScopes,
        },
        "upstream discovery applied — switching to oauth mode",
    );
    return { ...merged, authMode: "oauth" };
}
