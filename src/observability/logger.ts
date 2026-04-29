import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

export function createLogger(level: LoggerOptions["level"] = "info"): Logger {
    return pino({
        level,
        base: { service: "orchid-mcp" },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
            level: (label) => ({ level: label }),
        },
    });
}
