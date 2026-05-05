import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        environment: "node",
        reporters: ["default"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
            include: ["src/**/*.ts"],
            // Exclude type-only files and the CLI entry point from coverage:
            //   - base.ts files declare interfaces (no runtime code to cover)
            //   - context.ts is an interface declaration
            //   - index.ts is the process entry point (exits, installs signal
            //     handlers, wires globals) — not meaningfully unit-testable;
            //     exercised by the live-boot smoke runs.
            exclude: [
                "src/**/*.d.ts",
                "src/auth/base.ts",
                "src/sessions/base.ts",
                "src/context.ts",
                "src/index.ts",
            ],
            thresholds: {
                // Global ≥80% target (hard-rule #3).
                lines: 80,
                statements: 80,
                branches: 80,
                functions: 80,
                // Per-directory tighter targets.
                "src/http/**": {
                    lines: 90,
                    statements: 90,
                    branches: 90,
                    functions: 90,
                },
                "src/sessions/**": {
                    lines: 90,
                    statements: 90,
                    branches: 90,
                    functions: 90,
                },
            },
        },
    },
});
