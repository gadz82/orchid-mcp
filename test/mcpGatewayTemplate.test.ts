import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/mcpGateway/template.js";

describe("renderTemplate", () => {
    it("substitutes a single placeholder", () => {
        expect(renderTemplate("Hello {{who}}.", { who: "Alice" })).toBe("Hello Alice.");
    });

    it("substitutes multiple placeholders", () => {
        expect(renderTemplate("{{a}} + {{b}} = {{c}}", { a: "1", b: "2", c: "3" })).toBe(
            "1 + 2 = 3",
        );
    });

    it("leaves undeclared references as literals", () => {
        expect(renderTemplate("Hi {{who}}.", {})).toBe("Hi {{who}}.");
    });

    it("treats whitespace inside braces as valid", () => {
        expect(renderTemplate("Hi {{  who  }}.", { who: "Bob" })).toBe("Hi Bob.");
    });

    it("ignores malformed placeholders", () => {
        expect(renderTemplate("Hi {who}} and {{who}", { who: "x" })).toBe("Hi {who}} and {{who}");
    });

    it("does not recurse into substituted output", () => {
        expect(renderTemplate("{{a}}", { a: "{{b}}", b: "real" })).toBe("{{b}}");
    });

    it("allows dashes and underscores in placeholder names", () => {
        expect(renderTemplate("{{a_b-c}}", { "a_b-c": "ok" })).toBe("ok");
    });

    it("skips placeholders starting with a digit (not a valid identifier)", () => {
        expect(renderTemplate("{{1bad}} stays", { "1bad": "x" })).toBe("{{1bad}} stays");
    });
});
