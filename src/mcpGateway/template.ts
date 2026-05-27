/**
 * Minimal ``{{var}}`` substitution for MCP prompt templates.
 *
 * Matches the integrator's choice in Phase γ design (no Jinja, no
 * loops, no conditionals). References to undeclared arguments are
 * left as literal ``{{name}}`` in the rendered output — the caller
 * can spot the mistake visually without the renderer crashing.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g;

export function renderTemplate(template: string, args: Record<string, string | undefined>): string {
    return template.replace(PLACEHOLDER_RE, (match, name: string) => {
        const value = args[name];
        return value !== undefined ? value : match;
    });
}
