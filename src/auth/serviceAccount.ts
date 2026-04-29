/**
 * Service-account :class:`AuthStrategy`.
 *
 * One static bearer token is shared across every MCP user — fine for a
 * single-user personal install, dangerous on a public endpoint. The
 * companion :func:`guardServiceAccountDeployment` refuses to start when
 * combining this mode with an internet-reachable bind address unless
 * the operator explicitly opts in.
 */

import { OrchidConfigError } from "../errors.js";
import type { AuthStrategy, MCPRequestContext, OrchidIdentity } from "./base.js";

export interface ServiceAccountStrategyOptions {
    serviceAccountToken: string;
    serviceAccountAuthDomain?: string;
}

/** Subject used for every request in service-account mode. */
export const SHARED_SUBJECT = "_shared";

export class ServiceAccountStrategy implements AuthStrategy {
    readonly mode = "service_account" as const;
    private readonly bearer: string;
    private readonly authDomain: string | undefined;

    constructor(opts: ServiceAccountStrategyOptions) {
        const token = (opts.serviceAccountToken ?? "").trim();
        if (token.length === 0) {
            throw new OrchidConfigError(
                "service_account mode requires ORCHID_MCP_SERVICE_ACCOUNT_TOKEN to be set to a non-empty value.",
            );
        }
        this.bearer = token;
        this.authDomain = opts.serviceAccountAuthDomain;
    }

    async resolve(_ctx: MCPRequestContext): Promise<OrchidIdentity> {
        const identity: OrchidIdentity = {
            bearer: this.bearer,
            subject: SHARED_SUBJECT,
        };
        if (this.authDomain !== undefined) {
            identity.authDomain = this.authDomain;
        }
        return identity;
    }
}

export interface DeploymentGuardInput {
    authMode: "service_account" | "oauth" | "discover";
    host: string;
    iUnderstandTheRisk: boolean;
}

const INTERNET_REACHABLE_HOSTS = new Set(["0.0.0.0", "::", "::0"]);

/**
 * Refuse to start when ``service_account`` mode is bound to a globally
 * reachable address without the operator acknowledging that every MCP
 * user will share one Orchid identity. See plan §534.
 */
export function guardServiceAccountDeployment(input: DeploymentGuardInput): void {
    if (input.authMode !== "service_account") {
        return;
    }
    if (!INTERNET_REACHABLE_HOSTS.has(input.host)) {
        return;
    }
    if (input.iUnderstandTheRisk) {
        return;
    }
    throw new OrchidConfigError(
        "Refusing to bind service_account mode to " +
            input.host +
            ": every MCP user would share one Orchid identity. " +
            "Set ORCHID_MCP_I_UNDERSTAND_THE_RISK=true to override, " +
            "or set ORCHID_MCP_HOST to a loopback address (e.g. 127.0.0.1).",
    );
}
