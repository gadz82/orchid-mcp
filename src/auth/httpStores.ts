/**
 * HTTP-backed implementations of :type:`ClientStore`,
 * :type:`AuthCodeStore`, and :type:`GatewayTokenStore`.
 *
 * The in-memory store is single-replica by design; these wrappers
 * delegate every mutation and lookup to orchid-api's
 * ``/mcp-gateway/state/*`` endpoints so two gateway replicas fronting
 * the same orchid-api share identical state.
 *
 * Each class holds the same :type:`GatewayStateClient` — the HTTP
 * resource it's tied to is a single logical store.  Instantiating
 * three separate HTTP clients would be wasteful (each keeps its own
 * idle connection in the global fetch agent) and would split
 * correlation-id propagation across parallel request trees.
 */

import type {
    AuthCodeRecord,
    AuthCodeStore,
    ClientStore,
    GatewayTokenRecord,
    GatewayTokenStore,
    RegisteredClient,
} from "./stores.js";

import { identityToRecord, type GatewayStateClient } from "./gatewayStateClient.js";

/* ── HttpClientStore ──────────────────────────────────────── */

/**
 * Shim from :type:`ClientStore` → :type:`GatewayStateClient`.
 * Responsibility is limited to shape-preserving delegation so tool
 * code can depend on the narrow :type:`ClientStore` interface rather
 * than on the client with its ten methods.
 */
export class HttpClientStore implements ClientStore {
    constructor(private readonly client: GatewayStateClient) {}

    register(client: RegisteredClient): Promise<void> {
        return this.client.registerClient(client);
    }

    get(clientId: string): Promise<RegisteredClient | null> {
        return this.client.getClient(clientId);
    }
}

/* ── HttpAuthCodeStore ────────────────────────────────────── */

/**
 * Shim from :type:`AuthCodeStore` → :type:`GatewayStateClient`.
 *
 * Note on :meth:`update`.  The HTTP endpoint accepts only the
 * post-exchange patch fields (``identity``, ``idp_access_token``,
 * ``idp_refresh_token``, ``idp_expires_at``) — not arbitrary record
 * fields.  That mirrors the in-memory store's usage: ``update`` is
 * only called from ``/oauth/callback`` once the upstream exchange
 * completes, and the fields above are precisely what the callback
 * fills in.  We silently drop any additional keys in the patch; a
 * future caller that expected those to persist would surface the
 * mismatch in :mod:`test/authOauth.test.ts` when it fails to observe
 * its change.
 */
export class HttpAuthCodeStore implements AuthCodeStore {
    constructor(private readonly client: GatewayStateClient) {}

    put(record: AuthCodeRecord): Promise<void> {
        return this.client.putAuthCode(record);
    }

    getByUpstreamState(upstreamState: string): Promise<AuthCodeRecord | null> {
        return this.client.getAuthCodeByUpstreamState(upstreamState);
    }

    update(code: string, patch: Partial<AuthCodeRecord>): Promise<void> {
        const wirePatch: Parameters<GatewayStateClient["updateAuthCode"]>[1] = {};
        if (patch.identity !== undefined) {
            wirePatch.identity = identityToRecord(patch.identity);
        }
        if (patch.idpAccessToken !== undefined) wirePatch.idpAccessToken = patch.idpAccessToken;
        if (patch.idpRefreshToken !== undefined) wirePatch.idpRefreshToken = patch.idpRefreshToken;
        if (patch.idpExpiresAt !== undefined) wirePatch.idpExpiresAt = patch.idpExpiresAt;
        return this.client.updateAuthCode(code, wirePatch);
    }

    consume(code: string): Promise<AuthCodeRecord | null> {
        return this.client.consumeAuthCode(code);
    }
}

/* ── HttpGatewayTokenStore ────────────────────────────────── */

/**
 * Shim from :type:`GatewayTokenStore` → :type:`GatewayStateClient`.
 *
 * Expiry is enforced upstream (the orchid-api endpoint returns 404 on
 * expired rows), so this shim doesn't need its own TTL bookkeeping —
 * unlike the file-backed store which prunes on mutation.
 */
export class HttpGatewayTokenStore implements GatewayTokenStore {
    constructor(private readonly client: GatewayStateClient) {}

    issue(record: GatewayTokenRecord): Promise<void> {
        return this.client.issueToken(record);
    }

    getByAccessToken(accessToken: string): Promise<GatewayTokenRecord | null> {
        return this.client.getTokenByAccessToken(accessToken);
    }

    getByRefreshToken(refreshToken: string): Promise<GatewayTokenRecord | null> {
        return this.client.getTokenByRefreshToken(refreshToken);
    }

    revoke(accessToken: string): Promise<void> {
        return this.client.revokeToken(accessToken);
    }
}

/* ── Convenience factory ─────────────────────────────────── */

export interface HttpStoreSet {
    clientStore: HttpClientStore;
    authCodeStore: HttpAuthCodeStore;
    tokenStore: HttpGatewayTokenStore;
}

/**
 * Build all three HTTP-backed stores against a single shared
 * :type:`GatewayStateClient`.  The supported multi-replica
 * persistence path.
 */
export function buildHttpStoreSet(client: GatewayStateClient): HttpStoreSet {
    return {
        clientStore: new HttpClientStore(client),
        authCodeStore: new HttpAuthCodeStore(client),
        tokenStore: new HttpGatewayTokenStore(client),
    };
}
