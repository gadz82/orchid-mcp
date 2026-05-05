/**
 * Token-endpoint grant handlers for :class:`MCPOAuthStrategy`.
 *
 * Extracted from ``oauth.ts`` so the OAuth-AS body stays focused on
 * lifecycle (resolve, route registration, metadata, register, authorize,
 * callback). The two grant flows here run independently from each
 * other and read enough state from :type:`MCPOAuthStrategyOptions`
 * that they're a clean SRP unit on their own.
 */

import type { ServerResponse } from "node:http";

import type { OrchidIdentity } from "./base.js";
import type { MCPOAuthStrategyOptions } from "./oauth.js";
import {
    epochSeconds,
    errorMessage,
    randomBase64Url,
    sha256Base64Url,
    tokenResponseBody,
    writeJson,
} from "./oauth_utils.js";
import type { GatewayTokenRecord } from "./stores.js";

/** Optional per-record copy of the upstream IdP token triple. */
interface IdPTokenCarry {
    idpAccessToken?: string;
    idpRefreshToken?: string;
    idpExpiresAt?: number;
}

export async function handleAuthorizationCodeGrant(
    opts: MCPOAuthStrategyOptions,
    form: URLSearchParams,
    res: ServerResponse,
): Promise<void> {
    const code = form.get("code");
    const codeVerifier = form.get("code_verifier");
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    if (code === null || codeVerifier === null || clientId === null || redirectUri === null) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
    }
    const record = await opts.authCodeStore.consume(code);
    if (record === null) {
        writeJson(res, 400, { error: "invalid_grant" });
        return;
    }
    if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
        writeJson(res, 400, { error: "invalid_grant" });
        return;
    }
    const expectedChallenge = await sha256Base64Url(codeVerifier);
    if (expectedChallenge !== record.codeChallenge) {
        writeJson(res, 400, { error: "invalid_grant", error_description: "bad_verifier" });
        return;
    }
    if (record.identity === undefined) {
        writeJson(res, 400, {
            error: "invalid_grant",
            error_description: "identity_unresolved",
        });
        return;
    }

    // Carry the upstream tokens from the auth-code record over to the
    // gateway-token record so the next refresh has something to hand
    // the upstream IdP. The spread-only-when-defined pattern is noisier
    // than direct assignment but satisfies ``exactOptionalPropertyTypes:
    // true`` — the tsconfig forbids passing a ``T | undefined`` to a
    // ``T?`` slot.
    const carry: IdPTokenCarry = {
        ...(record.idpAccessToken !== undefined ? { idpAccessToken: record.idpAccessToken } : {}),
        ...(record.idpRefreshToken !== undefined
            ? { idpRefreshToken: record.idpRefreshToken }
            : {}),
        ...(record.idpExpiresAt !== undefined ? { idpExpiresAt: record.idpExpiresAt } : {}),
    };
    const issued = await mintGatewayTokens(opts, clientId, record.identity, record.scopes, carry);
    writeJson(res, 200, tokenResponseBody(issued));
}

export async function handleRefreshTokenGrant(
    opts: MCPOAuthStrategyOptions,
    form: URLSearchParams,
    res: ServerResponse,
): Promise<void> {
    const refreshToken = form.get("refresh_token");
    const clientId = form.get("client_id");
    if (refreshToken === null || clientId === null) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
    }
    const existing = await opts.tokenStore.getByRefreshToken(refreshToken);
    if (existing === null || existing.clientId !== clientId) {
        writeJson(res, 400, { error: "invalid_grant" });
        return;
    }

    // When a refresh delegate is wired AND we actually have a stored
    // upstream refresh token to swap, kick off the upstream refresh
    // before minting the new gateway pair. The fresh upstream access
    // token lands in ``identity.bearer`` (gateway → orchid-api will
    // use it on the very next MCP request), and the new upstream
    // refresh token replaces the stored one (OAuth 2.1 rotation).
    // When either condition is unmet, we fall back to rotating only
    // the gateway pair — acceptable when the upstream token is still
    // within its TTL.
    let identity: OrchidIdentity = existing.identity;
    let idpTokens: IdPTokenCarry = {
        ...(existing.idpAccessToken !== undefined
            ? { idpAccessToken: existing.idpAccessToken }
            : {}),
        ...(existing.idpRefreshToken !== undefined
            ? { idpRefreshToken: existing.idpRefreshToken }
            : {}),
        ...(existing.idpExpiresAt !== undefined ? { idpExpiresAt: existing.idpExpiresAt } : {}),
    };
    if (
        opts.refreshUpstreamToken !== undefined &&
        existing.idpRefreshToken !== undefined &&
        existing.idpRefreshToken.length > 0
    ) {
        try {
            const fresh = await opts.refreshUpstreamToken(existing.idpRefreshToken);
            identity = { ...existing.identity, bearer: fresh.access_token };
            idpTokens = {
                idpAccessToken: fresh.access_token,
                idpRefreshToken: fresh.refresh_token ?? existing.idpRefreshToken,
                ...(fresh.expires_at !== undefined ? { idpExpiresAt: fresh.expires_at } : {}),
            };
        } catch (err) {
            // Upstream rejected the refresh (user logged out at the
            // IdP, admin revoked the grant, …). Surface a standard
            // ``invalid_grant`` so the MCP client runs the full
            // re-authentication dance instead of silently rotating
            // gateway tokens that wrap a dead upstream bearer.
            opts.logger.warn(
                { err: errorMessage(err) },
                "upstream refresh failed — forcing re-authentication",
            );
            writeJson(res, 400, {
                error: "invalid_grant",
                error_description: "upstream_refresh_failed",
            });
            return;
        }
    }

    // Rotate both access and refresh tokens (OAuth 2.1 recommendation).
    await opts.tokenStore.revoke(existing.accessToken);
    const issued = await mintGatewayTokens(opts, clientId, identity, existing.scopes, idpTokens);
    writeJson(res, 200, tokenResponseBody(issued));
}

export async function mintGatewayTokens(
    opts: MCPOAuthStrategyOptions,
    clientId: string,
    identity: OrchidIdentity,
    scopes: string[],
    idpTokens: IdPTokenCarry = {},
): Promise<GatewayTokenRecord> {
    const record: GatewayTokenRecord = {
        accessToken: `gw-at-${randomBase64Url(32)}`,
        refreshToken: `gw-rt-${randomBase64Url(32)}`,
        clientId,
        subject: identity.subject,
        identity,
        expiresAt: epochSeconds() + opts.tokenTtlS,
        scopes,
        ...(idpTokens.idpAccessToken !== undefined
            ? { idpAccessToken: idpTokens.idpAccessToken }
            : {}),
        ...(idpTokens.idpRefreshToken !== undefined
            ? { idpRefreshToken: idpTokens.idpRefreshToken }
            : {}),
        ...(idpTokens.idpExpiresAt !== undefined ? { idpExpiresAt: idpTokens.idpExpiresAt } : {}),
    };
    await opts.tokenStore.issue(record);
    return record;
}
