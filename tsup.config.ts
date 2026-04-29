import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    outDir: "dist",
    splitting: false,
    sourcemap: true,
    clean: true,
    minify: false,
    dts: false,
    shims: false,
});
