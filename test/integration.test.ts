/**
 * Opt-in integration test against a live ``orchid-api`` container.
 *
 * Gated by ``RUN_INTEGRATION=1`` because it needs Docker and can take
 * several minutes on first run (image build + pip install). Exercises
 * only the CRUD endpoints that don't require Ollama to be reachable.
 *
 * Run locally:
 *     cd orchid-mcp
 *     RUN_INTEGRATION=1 npm test -- test/integration.test.ts
 *
 * The test spins up the ``qdrant`` + ``agents-api`` services from the
 * root ``docker-compose.demo.yml`` via :mod:`testcontainers` and tears
 * them down in ``afterAll``.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UndiciOrchidAPIClient } from "../src/http/undiciOrchidClient.js";

const runIntegration = process.env.RUN_INTEGRATION === "1";

const STARTUP_TIMEOUT_MS = 6 * 60 * 1000;
const TEARDOWN_TIMEOUT_MS = 60 * 1000;

describe.skipIf(!runIntegration)("integration: gateway client against live orchid-api", () => {
    let stopEnv: (() => Promise<void>) | null = null;
    let baseUrl = "";

    beforeAll(async () => {
        const { DockerComposeEnvironment, Wait } = await import("testcontainers");
        const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
        const env = await new DockerComposeEnvironment(projectRoot, "docker-compose.demo.yml")
            .withWaitStrategy(
                "agents-api",
                Wait.forHttp("/health", 8000).withStartupTimeout(240_000),
            )
            .up(["qdrant", "agents-api"]);
        const api = env.getContainer("agents-api-1");
        baseUrl = `http://${api.getHost()}:${String(api.getMappedPort(8000))}`;
        stopEnv = async () => {
            await env.down({ removeVolumes: true });
        };
    }, STARTUP_TIMEOUT_MS);

    afterAll(async () => {
        if (stopEnv !== null) {
            await stopEnv();
            stopEnv = null;
        }
    }, TEARDOWN_TIMEOUT_MS);

    it(
        "creates, lists, and switches chats through UndiciOrchidAPIClient",
        async () => {
            const client = new UndiciOrchidAPIClient({ baseUrl, timeoutMs: 60_000 });
            const opts = { bearer: "dev-token-any-value-works-with-dev-bypass" };

            try {
                const initial = await client.listChats(opts);
                const startCount = initial.length;

                const chat1 = await client.createChat(opts, "Integration test A");
                expect(chat1.id).toBeTruthy();
                expect(chat1.title).toBe("Integration test A");

                const chat2 = await client.createChat(opts, "Integration test B");
                expect(chat2.id).not.toBe(chat1.id);

                const after = await client.listChats(opts);
                expect(after.length).toBe(startCount + 2);
                expect(after.some((c) => c.id === chat1.id)).toBe(true);
                expect(after.some((c) => c.id === chat2.id)).toBe(true);

                // Ownership probe: getMessages succeeds for a chat we own and
                // returns an empty list because no messages have been sent yet.
                const msgs = await client.getMessages(opts, chat1.id, 1, 0);
                expect(msgs).toEqual([]);
            } finally {
                await client.close();
            }
        },
        STARTUP_TIMEOUT_MS,
    );
});
