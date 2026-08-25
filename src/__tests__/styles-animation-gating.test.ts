/**
 * Animation-gating guards on the shipped stylesheet (I198).
 *
 * Two regression classes, both invisible to esbuild (it never parses CSS) and
 * to jsdom (it does not apply stylesheets or run animations):
 *
 *   1. IDLE INDICATOR STILL ANIMATES. `.agent-client-loading-indicator` is
 *      hidden between turns with `visibility: hidden`, which preserves the
 *      reserved layout box but does NOT suspend CSS animations in Chromium
 *      (only `display: none` does). So the nine `dotPulse` dots kept animating
 *      continuously for the entire lifetime of every open chat view, idle or
 *      not — measured at a sustained 120 fps of compositing on a ProMotion
 *      display, which macOS surfaces as "Using Significant Energy".
 *
 *   2. NO REDUCED-MOTION ESCAPE HATCH. Every `infinite` animation ran
 *      unconditionally, with no `prefers-reduced-motion` handling anywhere in
 *      the stylesheet — an accessibility gap (WCAG 2.3.3) that also denied
 *      motion-sensitive users any way to avoid the compositing cost.
 *
 * The reduced-motion assertion derives the set of animation-bearing selectors
 * FROM the stylesheet and then checks coverage, rather than hard-coding a list
 * that would silently miss a fifth animation added later.
 *
 * Companion runtime probe: INV-8 in tools/invariant-suite (asserts zero
 * RUNNING animations on a hidden indicator inside a real Obsidian, which is
 * the actual user-visible outcome this file can only approximate).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Rule, type AtRule } from "postcss";

const cssPath = resolve(process.cwd(), "styles.css");
const root = postcss.parse(readFileSync(cssPath, "utf8"));

/** Every top-level rule (not nested inside an at-rule). */
function topLevelRules(): Rule[] {
	const out: Rule[] = [];
	root.walkRules((rule) => {
		if (rule.parent?.type === "root") out.push(rule);
	});
	return out;
}

/** Selectors that declare a non-stopped animation, derived from the sheet. */
function animatedSelectors(): string[] {
	const found = new Set<string>();
	for (const rule of topLevelRules()) {
		for (const decl of rule.nodes ?? []) {
			if (decl.type !== "decl") continue;
			const prop = decl.prop.toLowerCase();
			const value = decl.value.toLowerCase();
			const declaresAnimation =
				prop === "animation" || prop === "animation-name";
			if (!declaresAnimation) continue;
			if (value === "none" || value.startsWith("none")) continue;
			for (const sel of rule.selector.split(",")) {
				found.add(sel.trim());
			}
		}
	}
	return [...found];
}

function reducedMotionBlocks(): AtRule[] {
	const out: AtRule[] = [];
	root.walkAtRules("media", (at) => {
		if (at.params.replace(/\s+/g, "").includes("prefers-reduced-motion:reduce")) {
			out.push(at);
		}
	});
	return out;
}

/** Does any rule in these at-rules neutralize `selector`'s animation? */
function neutralizedIn(blocks: AtRule[], selector: string): boolean {
	for (const block of blocks) {
		let hit = false;
		block.walkRules((rule) => {
			const covers = rule.selector
				.split(",")
				.map((s) => s.trim())
				.some((s) => s === selector);
			if (!covers) return;
			for (const decl of rule.nodes ?? []) {
				if (decl.type !== "decl") continue;
				const prop = decl.prop.toLowerCase();
				const value = decl.value.toLowerCase();
				if (prop === "animation" && value.startsWith("none")) hit = true;
				if (prop === "animation-name" && value.startsWith("none")) hit = true;
				if (prop === "animation-play-state" && value.includes("paused")) hit = true;
				if (prop === "animation-duration" && /^0s?$/.test(value.trim())) hit = true;
			}
		});
		if (hit) return true;
	}
	return false;
}

describe("I198 — idle loading indicator does not animate", () => {
	it("sanity: the stylesheet parsed and declares the loading dot", () => {
		const selectors = topLevelRules().map((r) => r.selector);
		expect(selectors).toContain(".agent-client-loading-dot");
	});

	it("neutralizes the dot animation while the indicator is hidden", () => {
		// visibility:hidden does not stop animations, so the hidden state must
		// explicitly stop them or the dots animate for the view's whole life.
		const target = ".agent-client-loading-indicator.agent-client-hidden";
		let stopped = false;
		for (const rule of topLevelRules()) {
			const sels = rule.selector.split(",").map((s) => s.trim());
			const scopesHiddenIndicator = sels.some(
				(s) => s.startsWith(target) && s.includes(".agent-client-loading-dot"),
			);
			if (!scopesHiddenIndicator) continue;
			for (const decl of rule.nodes ?? []) {
				if (decl.type !== "decl") continue;
				const prop = decl.prop.toLowerCase();
				const value = decl.value.toLowerCase();
				if (prop === "animation" && value.startsWith("none")) stopped = true;
				if (prop === "animation-name" && value.startsWith("none")) stopped = true;
				if (prop === "animation-play-state" && value.includes("paused"))
					stopped = true;
			}
		}
		expect(
			stopped,
			`no rule stops .agent-client-loading-dot animation under ${target} — ` +
				"the nine dots animate continuously while the indicator is invisible",
		).toBe(true);
	});

	it("keeps the hidden indicator's reserved layout box (no display:none swap)", () => {
		// The fix must not switch to display:none: the reserved box prevents a
		// layout jump when the indicator appears at the start of a turn.
		const hidden = topLevelRules().find(
			(r) =>
				r.selector.trim() ===
				".agent-client-loading-indicator.agent-client-hidden",
		);
		expect(hidden, "the hidden-indicator rule vanished").toBeDefined();
		const props = (hidden?.nodes ?? [])
			.filter((n) => n.type === "decl")
			.map((n) => `${n.prop}:${n.value}`.toLowerCase().replace(/\s/g, ""));
		expect(props).toContain("visibility:hidden");
		expect(props.some((p) => p.startsWith("display:none"))).toBe(false);
	});
});

describe("I198 — prefers-reduced-motion is honored", () => {
	it("the stylesheet has a reduced-motion block", () => {
		expect(
			reducedMotionBlocks().length,
			"styles.css has no @media (prefers-reduced-motion: reduce) block",
		).toBeGreaterThan(0);
	});

	it("every animated selector is neutralized under reduced motion", () => {
		const blocks = reducedMotionBlocks();
		const selectors = animatedSelectors();
		// Guard against a vacuous pass if the sheet ever stops animating anything.
		expect(selectors.length).toBeGreaterThan(0);
		const uncovered = selectors.filter((s) => !neutralizedIn(blocks, s));
		expect(
			uncovered,
			`these animated selectors are not neutralized under reduced motion: ${uncovered.join(", ")}`,
		).toEqual([]);
	});
});
