/**
 * Errors thrown by the gateway. Kept narrow so tool handlers can map each
 * one onto a specific MCP error code / isError content block without
 * pattern-matching on generic Error instances.
 */

export class OrchidGatewayError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

export class OrchidUnauthorizedError extends OrchidGatewayError {}

export class OrchidTimeoutError extends OrchidGatewayError {}

export class OrchidServerError extends OrchidGatewayError {
    constructor(
        message: string,
        public readonly status: number,
        public readonly body?: unknown,
    ) {
        super(message);
    }
}

export class OrchidResponseShapeError extends OrchidGatewayError {}

export class OrchidConfigError extends OrchidGatewayError {}
