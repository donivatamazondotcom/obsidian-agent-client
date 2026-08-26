/**
 * I201 — the composer textarea must not be repainted by Obsidian's form-field
 * styling in any interactive state.
 *
 * Obsidian core (app.css) styles EVERY `<textarea>` as a form field. One of those
 * rules is a hover repaint:
 *
 *     @media (hover: hover) {
 *       textarea:not(:disabled):hover {
 *         background-color: var(--background-modifier-form-field-hover);
 *         border-color: var(--background-modifier-border-hover);
 *       }
 *     }
 *
 * Its specificity is (0,2,1) — `:not(:disabled)` contributes the specificity of
 * its argument, so this is the ONE app.css state rule that outranks a plain
 * `.class:hover` (0,2,0). The plugin's original suppression rule was exactly
 * `.agent-client-chat-input-textarea:hover` (0,2,0), so app.css won and the
 * composer's inner box changed colour on hover. Because the textarea is a CHILD
 * of `.agent-client-chat-input-box`, that painted background also covered the
 * locked state's `box-shadow: inset 3px 0 0 0 var(--interactive-accent)` accent
 * bar — the "bleed into the locked border" half of the same bug.
 *
 * This is theme-independent: the winning rule lives in core app.css, so it fires
 * under every theme. The theme only decides whether
 * `--background-modifier-form-field-hover` composites lighter or darker than
 * `--background-primary` (stock dark: lighter; Catppuccin: darker).
 *
 * Neither esbuild (never parses CSS) nor jsdom (never applies stylesheets) can
 * see this class of regression, so it is guarded here at the source level by
 * computing selector specificity and comparing it against the app.css rule the
 * plugin has to clear.
 *
 * Companion outcome assertion: a CDP `CSS.forcePseudoState` A/B against a real
 * Obsidian, which is the actual user-visible outcome this file approximates.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Rule } from "postcss";

const cssPath = resolve(process.cwd(), "styles.css");
const root = postcss.parse(readFileSync(cssPath, "utf8"));

type Spec = [number, number, number];

/** The app.css rule the plugin must outrank: `textarea:not(:disabled):hover`. */
const APP_CSS_TEXTAREA_HOVER: Spec = [0, 2, 1];

const COMPOSER_TEXTAREA = ".agent-client-chat-input-textarea";

/** Split a selector list on commas that sit at paren depth 0. */
function splitTopLevel(input: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of input) {
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) out.push(current);
	return out.map((s) => s.trim()).filter(Boolean);
}

function compareSpec(x: Spec, y: Spec): number {
	for (let i = 0; i < 3; i++) {
		if (x[i] !== y[i]) return x[i] - y[i];
	}
	return 0;
}

/**
 * Selectors Level 4 specificity for a single complex selector.
 * `:is()/:not()/:has()` take the specificity of their most specific argument;
 * `:where()` contributes nothing.
 */
function specificity(selector: string): Spec {
	let a = 0;
	let b = 0;
	let c = 0;
	const s = selector.trim().replace(/\s*[>+~]\s*/g, " ");
	let i = 0;
	while (i < s.length) {
		const rest = s.slice(i);
		const ch = s[i];
		if (ch === "#") {
			const m = /^#[\w-]+/.exec(rest);
			if (!m) break;
			a++;
			i += m[0].length;
			continue;
		}
		if (ch === ".") {
			const m = /^\.[\w-]+/.exec(rest);
			if (!m) break;
			b++;
			i += m[0].length;
			continue;
		}
		if (ch === "[") {
			const end = s.indexOf("]", i);
			b++;
			i = end === -1 ? s.length : end + 1;
			continue;
		}
		if (ch === ":") {
			if (s[i + 1] === ":") {
				const m = /^::[\w-]+/.exec(rest);
				if (!m) break;
				c++;
				i += m[0].length;
				continue;
			}
			const m = /^:[\w-]+/.exec(rest);
			if (!m) {
				i++;
				continue;
			}
			const name = m[0].slice(1).toLowerCase();
			let j = i + m[0].length;
			if (s[j] === "(") {
				let depth = 0;
				let k = j;
				for (; k < s.length; k++) {
					if (s[k] === "(") depth++;
					else if (s[k] === ")") {
						depth--;
						if (depth === 0) break;
					}
				}
				const inner = s.slice(j + 1, k);
				if (name === "not" || name === "is" || name === "has") {
					let best: Spec = [0, 0, 0];
					for (const arg of splitTopLevel(inner)) {
						const sp = specificity(arg);
						if (compareSpec(sp, best) > 0) best = sp;
					}
					a += best[0];
					b += best[1];
					c += best[2];
				} else if (name !== "where") {
					b++;
				}
				i = k + 1;
				continue;
			}
			b++;
			i = j;
			continue;
		}
		if (ch === "*" || ch === " ") {
			i++;
			continue;
		}
		const m = /^[a-zA-Z][\w-]*/.exec(rest);
		if (m) {
			c++;
			i += m[0].length;
			continue;
		}
		i++;
	}
	return [a, b, c];
}

/** Every rule in the sheet, including rules nested inside at-rules. */
function allRules(): Rule[] {
	const out: Rule[] = [];
	root.walkRules((rule) => {
		out.push(rule);
	});
	return out;
}

function declarations(rule: Rule): Array<{ prop: string; value: string }> {
	return (rule.nodes ?? [])
		.filter((n): n is postcss.Declaration => n.type === "decl")
		.map((n) => ({
			prop: n.prop.toLowerCase().trim(),
			value: n.value.toLowerCase().trim(),
		}));
}

/**
 * Selector parts that target the composer textarea in a hover state, paired
 * with the rule that declared them. Derived from the sheet, not hard-coded, so
 * a rule added later is picked up automatically.
 */
function composerHoverParts(): Array<{ part: string; rule: Rule }> {
	const out: Array<{ part: string; rule: Rule }> = [];
	for (const rule of allRules()) {
		for (const part of splitTopLevel(rule.selector)) {
			if (!part.includes(COMPOSER_TEXTAREA)) continue;
			if (!/:hover(?![\w-])/.test(part)) continue;
			out.push({ part, rule });
		}
	}
	return out;
}

describe("I201 — specificity helper", () => {
	// The whole test rests on this helper, so pin it against known values —
	// a wrong helper would otherwise manufacture a false green.
	it("scores the app.css rule the plugin must clear as (0,2,1)", () => {
		expect(specificity("textarea:not(:disabled):hover")).toEqual([0, 2, 1]);
	});

	it("scores the plain class-plus-hover shape as (0,2,0)", () => {
		expect(specificity(`${COMPOSER_TEXTAREA}:hover`)).toEqual([0, 2, 0]);
	});

	it("scores element+class qualification above the app.css rule", () => {
		const sel = `.agent-client-chat-input-box textarea${COMPOSER_TEXTAREA}:hover`;
		expect(specificity(sel)).toEqual([0, 3, 1]);
		expect(compareSpec(specificity(sel), APP_CSS_TEXTAREA_HOVER)).toBeGreaterThan(0);
	});

	it("ignores :where() and counts ids", () => {
		expect(specificity(":where(.a.b) textarea")).toEqual([0, 0, 1]);
		expect(specificity("#x .y z")).toEqual([1, 1, 1]);
	});
});

describe("I201 — composer textarea keeps a transparent background on hover", () => {
	it("sanity: the stylesheet declares the composer textarea", () => {
		// Vacuity guard: if the class is ever renamed, fail loudly here rather
		// than silently passing the assertions below on an empty set.
		const selectors = allRules().map((r) => r.selector);
		expect(selectors.some((s) => s.includes(COMPOSER_TEXTAREA))).toBe(true);
	});

	it("has a hover rule that outranks app.css and clears the background", () => {
		const candidates = composerHoverParts().filter((entry) =>
			declarations(entry.rule).some(
				(d) => d.prop === "background-color" && d.value === "transparent",
			),
		);
		expect(
			candidates.length,
			`no rule targets ${COMPOSER_TEXTAREA} on :hover with ` +
				"background-color: transparent",
		).toBeGreaterThan(0);

		const winning = candidates.filter(
			(entry) =>
				compareSpec(specificity(entry.part), APP_CSS_TEXTAREA_HOVER) > 0,
		);
		expect(
			winning.map((w) => `${w.part} => ${specificity(w.part).join("-")}`),
			"the composer's hover suppression does not outrank app.css " +
				`textarea:not(:disabled):hover (${APP_CSS_TEXTAREA_HOVER.join("-")}); ` +
				"Obsidian repaints the textarea on hover and the fill bleeds into " +
				"the locked-composer accent bar",
		).not.toEqual([]);
	});

	it("no hover rule paints a non-transparent background on the textarea", () => {
		const offenders: string[] = [];
		for (const entry of composerHoverParts()) {
			for (const d of declarations(entry.rule)) {
				const paints = d.prop === "background-color" || d.prop === "background";
				if (!paints) continue;
				if (d.value === "transparent" || d.value === "none") continue;
				offenders.push(`${entry.part} { ${d.prop}: ${d.value} }`);
			}
		}
		expect(offenders, "composer textarea is repainted on hover").toEqual([]);
	});
});

describe("I201 — composer transitions name their properties", () => {
	it("the send button does not use `transition: all`", () => {
		// `transition: all` animates whatever property change lands next. Nothing
		// animatable changes on the button element itself (only `cursor`); the
		// icon colour is handled by `.agent-client-chat-send-button svg`.
		const offenders: string[] = [];
		for (const rule of allRules()) {
			const parts = splitTopLevel(rule.selector);
			if (!parts.some((p) => p.trim() === ".agent-client-chat-send-button")) {
				continue;
			}
			for (const d of declarations(rule)) {
				if (d.prop === "transition" && /^all(\s|$)/.test(d.value)) {
					offenders.push(`${rule.selector} { transition: ${d.value} }`);
				}
				if (d.prop === "transition-property" && d.value === "all") {
					offenders.push(`${rule.selector} { transition-property: all }`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
