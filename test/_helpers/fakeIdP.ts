/**
 * In-process fake OIDC identity provider for tests.
 *
 * Minimal: three endpoints (authorize, token, userinfo). No JWKS, no
 * id_token signing — the gateway's OAuth strategy doesn't verify
 * id_tokens, so we can keep this simple. Good enough to exercise the
 * full authorization-code + PKCE + refresh flow against an actual
 * HTTP listener with no network dependencies.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

export interface FakeIdPUser {
    sub: string;
    email?: string;
    name?: string;
}

export interface FakeIdPOptions {
    /** Claims returned by ``/userinfo`` for the autograted flow. */
    user: FakeIdPUser;
    /** When true, ``/authorize`` returns ``error=access_denied`` instead. */
    denyNextAuthorize?: boolean;
    /** When true, ``/token`` returns a 400 on the first call. */
    failNextTokenExchange?: boolean;
    /**
     * When set, the ``/userinfo`` response wraps the ``user`` payload
     * under the given top-level key — and uses ``userIdField`` /
     * ``emailField`` as the payload-side key names.  Lets tests
     * simulate non-OIDC shapes like
     * ``{"data": {"user_id": 42, "email": "..."}}``.
     */
    nonOidcWrapper?: {
        wrapperKey: string;
        userIdField: string;
        emailField: string;
        /** When set, ``user_id`` is emitted as a number instead of a string. */
        userIdAsNumber?: boolean;
    };
}

interface PendingCode {
    code: string;
    state: string;
    redirectUri: string;
    clientId: string;
    codeChallenge: string;
}

export class FakeIdP {
    private server: Server | null = null;
    private opts: FakeIdPOptions;
    private port = 0;
    private pending = new Map<string, PendingCode>();
    private issuedRefreshTokens = new Set<string>();

    constructor(opts: FakeIdPOptions) {
        this.opts = opts;
    }

    async start(): Promise<{
        issuer: string;
        authorizationEndpoint: string;
        tokenEndpoint: string;
        userinfoEndpoint: string;
    }> {
        this.server = createServer((req, res) => {
            void this.handle(req, res);
        });
        await new Promise<void>((resolve) => {
            this.server?.listen(0, "127.0.0.1", () => resolve());
        });
        const addr = this.server.address() as AddressInfo;
        this.port = addr.port;
        const base = `http://127.0.0.1:${String(addr.port)}`;
        return {
            issuer: base,
            authorizationEndpoint: `${base}/authorize`,
            tokenEndpoint: `${base}/token`,
            userinfoEndpoint: `${base}/userinfo`,
        };
    }

    async stop(): Promise<void> {
        if (this.server === null) return;
        await new Promise<void>((resolve, reject) => {
            this.server?.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        this.server = null;
    }

    /**
     * Merge-override the current options.  Passing ``undefined`` for
     * an optional key explicitly *clears* it (rather than short-circuiting
     * to the existing value), so tests can reset state after exercising
     * a non-default configuration.
     */
    setOptions(
        opts: { [K in keyof FakeIdPOptions]?: FakeIdPOptions[K] | undefined },
    ): void {
        const merged = { ...this.opts } as Record<string, unknown>;
        for (const [key, value] of Object.entries(opts)) {
            if (value === undefined) {
                delete merged[key];
            } else {
                merged[key] = value;
            }
        }
        this.opts = merged as unknown as FakeIdPOptions;
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(this.port)}`);
            if (url.pathname === "/authorize" && req.method === "GET") {
                this.handleAuthorize(url, res);
                return;
            }
            if (url.pathname === "/token" && req.method === "POST") {
                await this.handleToken(req, res);
                return;
            }
            if (url.pathname === "/userinfo" && req.method === "GET") {
                this.handleUserinfo(req, res);
                return;
            }
            res.writeHead(404).end();
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    error: "server_error",
                    error_description: err instanceof Error ? err.message : String(err),
                }),
            );
        }
    }

    private handleAuthorize(url: URL, res: ServerResponse): void {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state") ?? "";
        const codeChallenge = url.searchParams.get("code_challenge") ?? "";
        const clientId = url.searchParams.get("client_id") ?? "";
        if (redirectUri === null) {
            res.writeHead(400).end("missing redirect_uri");
            return;
        }
        const redirect = new URL(redirectUri);
        if (this.opts.denyNextAuthorize === true) {
            this.opts.denyNextAuthorize = false;
            redirect.searchParams.set("error", "access_denied");
            redirect.searchParams.set("state", state);
            res.writeHead(302, { Location: redirect.toString() });
            res.end();
            return;
        }
        const code = `idp-code-${randomUUID()}`;
        this.pending.set(code, { code, state, redirectUri, clientId, codeChallenge });
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", state);
        res.writeHead(302, { Location: redirect.toString() });
        res.end();
    }

    private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (this.opts.failNextTokenExchange === true) {
            this.opts.failNextTokenExchange = false;
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
        }
        const body = await readBody(req);
        const form = new URLSearchParams(body);
        const grantType = form.get("grant_type");
        if (grantType === "authorization_code") {
            const code = form.get("code") ?? "";
            const record = this.pending.get(code);
            if (record === undefined) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid_grant" }));
                return;
            }
            this.pending.delete(code);
            this.issueTokens(res);
            return;
        }
        if (grantType === "refresh_token") {
            const refresh = form.get("refresh_token") ?? "";
            if (!this.issuedRefreshTokens.has(refresh)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid_grant" }));
                return;
            }
            this.issueTokens(res);
            return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_grant_type" }));
    }

    private issueTokens(res: ServerResponse): void {
        const accessToken = `idp-at-${randomUUID()}`;
        const refreshToken = `idp-rt-${randomUUID()}`;
        this.issuedRefreshTokens.add(refreshToken);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                access_token: accessToken,
                refresh_token: refreshToken,
                token_type: "Bearer",
                expires_in: 3600,
                scope: "openid profile email",
            }),
        );
    }

    private handleUserinfo(req: IncomingMessage, res: ServerResponse): void {
        const auth = req.headers.authorization;
        if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
            res.writeHead(401).end();
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        const wrapper = this.opts.nonOidcWrapper;
        if (wrapper === undefined) {
            res.end(JSON.stringify(this.opts.user));
            return;
        }
        const payload: Record<string, unknown> = {
            [wrapper.userIdField]:
                wrapper.userIdAsNumber === true
                    ? Number(this.opts.user.sub)
                    : this.opts.user.sub,
        };
        if (this.opts.user.email !== undefined) {
            payload[wrapper.emailField] = this.opts.user.email;
        }
        res.end(JSON.stringify({ [wrapper.wrapperKey]: payload }));
    }
}

async function readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
