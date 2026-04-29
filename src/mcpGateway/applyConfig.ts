/**
 * Apply an :type:`GatewayConfig` to a freshly-built :class:`McpServer`.
 *
 * Runs during MCP session init, after tool defaults are registered:
 * - per-tool title/description overrides via :meth:`RegisteredTool.update`
 * - :tool:`orchid_*` prompts registered via :meth:`McpServer.registerPrompt`,
 *   each rendering its template at ``prompts/get`` time via
 *   :func:`renderTemplate`.
 *
 * All operations are best-effort — a bad prompt never aborts session
 * init; we log a warning and skip it so the rest of the surface comes
 * up cleanly.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { GatewayConfig, GatewayPrompt } from "../http/orchidClient.js";
import type { Logger } from "../observability/logger.js";
import { renderTemplate } from "./template.js";

/** Opaque handle returned by registerTool — we only call .update on it. */
export interface ToolUpdateHandle {
    update(updates: { title?: string; description?: string }): void;
}

/**
 * Apply title/description overrides + register prompt templates.
 *
 * ``toolHandles`` maps canonical tool name → the :class:`RegisteredTool`
 * returned by :meth:`McpServer.registerTool`. Tools not listed in the
 * config keep their defaults.
 */
export function applyGatewayConfig(
    server: McpServer,
    toolHandles: Map<string, ToolUpdateHandle>,
    config: GatewayConfig,
    logger: Logger,
): void {
    // 1. Tool overrides
    for (const [name, override] of Object.entries(config.tools)) {
        const handle = toolHandles.get(name);
        if (handle === undefined) {
            logger.warn({ tool: name }, "gateway config references unknown tool; ignoring");
            continue;
        }
        const updates: { title?: string; description?: string } = {};
        if (
            override.title !== undefined &&
            override.title !== null &&
            override.title.length > 0
        ) {
            updates.title = override.title;
        }
        if (
            override.description !== undefined &&
            override.description !== null &&
            override.description.length > 0
        ) {
            updates.description = override.description;
        }
        if (Object.keys(updates).length > 0) {
            try {
                handle.update(updates);
            } catch (err) {
                logger.warn({ err, tool: name }, "failed to apply tool override");
            }
        }
    }

    // 2. Prompt registration
    for (const prompt of config.prompts) {
        try {
            registerPrompt(server, prompt, logger);
        } catch (err) {
            logger.warn({ err, prompt: prompt.name }, "failed to register prompt");
        }
    }
}

function registerPrompt(server: McpServer, prompt: GatewayPrompt, logger: Logger): void {
    const argsSchema: Record<string, z.ZodTypeAny> = {};
    for (const arg of prompt.arguments) {
        const schema = arg.required ? z.string() : z.string().optional();
        argsSchema[arg.name] = schema;
    }

    const config: {
        title?: string;
        description?: string;
        argsSchema: Record<string, z.ZodTypeAny>;
    } = { argsSchema };
    if (prompt.title !== undefined && prompt.title !== null && prompt.title.length > 0) {
        config.title = prompt.title;
    }
    if (
        prompt.description !== undefined &&
        prompt.description !== null &&
        prompt.description.length > 0
    ) {
        config.description = prompt.description;
    }

    server.registerPrompt(prompt.name, config, (args: Record<string, string | undefined>) => {
        const rendered = renderTemplate(prompt.template, args);
        logger.debug(
            { prompt: prompt.name, argCount: Object.keys(args).length },
            "rendered prompt",
        );
        const result: {
            messages: { role: "user"; content: { type: "text"; text: string } }[];
            description?: string;
        } = {
            messages: [
                {
                    role: "user",
                    content: { type: "text", text: rendered },
                },
            ],
        };
        if (
            prompt.description !== undefined &&
            prompt.description !== null &&
            prompt.description.length > 0
        ) {
            result.description = prompt.description;
        }
        return result;
    });
}
