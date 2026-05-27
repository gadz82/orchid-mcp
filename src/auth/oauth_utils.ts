/**
 * Module-private utilities used by :class:`MCPOAuthStrategy`.
 *
 * Pulled out of ``oauth.ts`` so the strategy file stays focused on the
 * spec wiring (metadata, DCR, authorize/callback, token endpoints).
 * Each helper here is a small pure function or a self-contained
 * Node-stream adapter.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { OrchidConfigError } from "../errors.js";

import type { GatewayTokenRecord } from "./stores.js";

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

export function tokenResponseBody(rec: GatewayTokenRecord): Record<string, unknown> {
    return {
        access_token: rec.accessToken,
        refresh_token: rec.refreshToken,
        token_type: "Bearer",
        expires_in: Math.max(0, rec.expiresAt - epochSeconds()),
        scope: rec.scopes.join(" "),
    };
}

export function queryParams(req: IncomingMessage): URLSearchParams {
    const url = new URL(req.url ?? "/", "http://placeholder");
    return url.searchParams;
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const text = await readRawBody(req);
    if (text.length === 0) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export async function readFormBody(req: IncomingMessage): Promise<URLSearchParams | null> {
    const text = await readRawBody(req);
    if (text.length === 0) return null;
    try {
        return new URLSearchParams(text);
    } catch {
        return null;
    }
}

export async function readRawBody(req: IncomingMessage): Promise<string> {
    const MAX = 1 * 1024 * 1024;
    return new Promise<string>((resolve, reject) => {
        let settled = false;
        let total = 0;
        const chunks: Buffer[] = [];

        // Multiple stream events (``data`` overshoot followed by ``end``,
        // or ``error`` racing ``aborted``) can fire after the promise has
        // already been resolved or rejected. The ``settled`` flag drops
        // every late event and removes the listeners so no further chunks
        // accumulate in memory.
        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            req.removeListener("data", onData);
            req.removeListener("end", onEnd);
            req.removeListener("error", onError);
            req.removeListener("aborted", onAborted);
            fn();
        };

        const onData = (chunk: Buffer): void => {
            if (settled) return;
            total += chunk.length;
            if (total > MAX) {
                req.destroy();
                settle(() => reject(new Error("body too large")));
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = (): void => {
            settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
        };
        const onError = (err: Error): void => {
            settle(() => reject(err));
        };
        const onAborted = (): void => {
            settle(() => reject(new Error("client aborted")));
        };

        req.on("data", onData);
        req.on("end", onEnd);
        req.on("error", onError);
        req.on("aborted", onAborted);
    });
}

export function randomBase64Url(bytes: number): string {
    return randomBytes(bytes).toString("base64url");
}

export async function sha256Base64Url(input: string): Promise<string> {
    const buf = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Buffer.from(digest).toString("base64url");
}

export function epochSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

/**
 * Squash an unknown error into a short string for structured logging.
 *
 * The raw ``err`` object frequently carries tokens, request bodies, or
 * stack traces upstream HTTP libraries pack onto their custom errors.
 * Pino serialises that whole tree by default — this helper bottlenecks
 * the surface to one ``message`` field so secrets can't leak by
 * accident.
 */
export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

export function validateBaseUrl(base: string): void {
    try {
        const u = new URL(base);
        if (u.search.length > 0 || u.hash.length > 0) {
            throw new OrchidConfigError(
                `oauthGatewayBaseUrl must not contain query/fragment: ${base}`,
            );
        }
    } catch (err) {
        if (err instanceof OrchidConfigError) throw err;
        throw new OrchidConfigError(`oauthGatewayBaseUrl is not a valid URL: ${base}`);
    }
}
