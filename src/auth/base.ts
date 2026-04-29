/**
 * Auth strategy contract.
 *
 * One implementation per authentication model (service-account, OAuth, …).
 * Strategies resolve an incoming MCP request into an Orchid-side identity
 * the HTTP client can use as a Bearer token.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface OrchidIdentity {
    /** Raw bearer token to forward to orchid-api. */
    bearer: string;
    /** Optional x-auth-domain header (tenant hint). */
    authDomain?: string;
    /** Stable per-user key used to partition the session map. */
    subject: string;
}

export interface MCPRequestContext {
    /** Session id from the MCP Streamable HTTP transport. */
    mcpSessionId: string;
    /** Bearer token presented by the MCP client, if any. */
    accessToken?: string;
    /** Raw request headers (lower-cased keys). */
    headers: Record<string, string>;
}

/**
 * A route the auth strategy mounts on the gateway's HTTP server.
 * Matches exact path + method; ``handle`` receives the raw Node request.
 */
export interface AuthRoute {
    method: "GET" | "POST" | "DELETE";
    path: string;
    handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

export interface AuthStrategy {
    readonly mode: "service_account" | "oauth";
    resolve(ctx: MCPRequestContext): Promise<OrchidIdentity>;
    /** Optional: declarative HTTP routes the gateway server should mount. */
    httpRoutes?(): AuthRoute[];
}
