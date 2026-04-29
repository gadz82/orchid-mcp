/**
 * Static guard enforcing the HTTP-only boundary (hard rule #1).
 *
 * ``orchid-mcp/src/`` must never reference anything inside the sibling
 * Python packages (``orchid/``, ``orchid-api/``) or climb out of its own
 * directory. This test greps every TypeScript source file and fails the
 * build on a single match.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC_DIR = join(PACKAGE_ROOT, "src");

const FORBIDDEN_SUBSTRINGS = [
    "orchid_ai",
    "orchid_api",
    "orchid-api/",
    "orchid-api\\",
    "../orchid/",
    "../orchid-api/",
    "../../orchid",
    "../../orchid-api",
];

async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...(await walk(full)));
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
            out.push(full);
        }
    }
    return out;
}

describe("import boundaries", () => {
    it("src/ contains TypeScript files to check", async () => {
        const info = await stat(SRC_DIR);
        expect(info.isDirectory()).toBe(true);
        const files = await walk(SRC_DIR);
        expect(files.length).toBeGreaterThan(0);
    });

    it("no src/ file references Python packages or escapes orchid-mcp/", async () => {
        const files = await walk(SRC_DIR);
        const offenders: { file: string; needle: string; line: number }[] = [];

        for (const file of files) {
            const contents = await readFile(file, "utf8");
            const lines = contents.split("\n");
            lines.forEach((line, idx) => {
                const trimmed = line.trim();
                if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
                    return;
                }
                for (const needle of FORBIDDEN_SUBSTRINGS) {
                    if (line.includes(needle)) {
                        offenders.push({
                            file: relative(PACKAGE_ROOT, file),
                            needle,
                            line: idx + 1,
                        });
                    }
                }
            });
        }

        expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
    });

    it("no src/ file imports from a path that escapes the package", async () => {
        const files = await walk(SRC_DIR);
        const offenders: { file: string; line: number; raw: string }[] = [];
        const importRegex = /^\s*import\b[^;]*from\s+['"]([^'"]+)['"]/;
        const exportRegex = /^\s*export\b[^;]*from\s+['"]([^'"]+)['"]/;

        for (const file of files) {
            const contents = await readFile(file, "utf8");
            const lines = contents.split("\n");
            lines.forEach((line, idx) => {
                const match = importRegex.exec(line) ?? exportRegex.exec(line);
                if (!match) {
                    return;
                }
                const spec = match[1] ?? "";
                if (!spec.startsWith(".")) {
                    return;
                }
                const resolved = resolve(file, "..", spec);
                if (!resolved.startsWith(SRC_DIR)) {
                    offenders.push({
                        file: relative(PACKAGE_ROOT, file),
                        line: idx + 1,
                        raw: line,
                    });
                }
            });
        }

        expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
    });
});
