// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["dist/**", "coverage/**", "node_modules/**"],
    },
    ...tseslint.configs.recommended,
    ...tseslint.configs.stylistic,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            "@typescript-eslint/consistent-type-imports": "error",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "no-console": ["warn", { allow: ["warn", "error"] }],
        },
    },
);
