/**
 * `deriveTooltipText` truth table.
 *
 * The resolver's whole job is WCAG 2.5.3 label-in-name: because Obsidian's
 * `setTooltip` writes `aria-label`, a tooltip that drops the element's visible
 * text replaces its accessible name with something invisible. The composition
 * assertions below are the regression guard for that (A2UI-I08 shipped exactly
 * that defect).
 */
import { describe, it, expect } from "vitest";
import { deriveTooltipText } from "../tooltip-text";

/** The shipped English separator. Locale-dependent, hence an input. */
const SEP = " — ";

describe("deriveTooltipText", () => {
	describe("the four-way truth table", () => {
		it("visible label + reason → composes so the label survives", () => {
			expect(
				deriveTooltipText({
					visibleLabel: "Sonnet 4.5",
					reason: "Balanced speed and depth",
					separator: SEP,
				}),
			).toEqual({
				kind: "text",
				text: "Sonnet 4.5 — Balanced speed and depth",
			});
		});

		it("visible label, no reason → none, because the text already names it", () => {
			expect(
				deriveTooltipText({
					visibleLabel: "Only this folder",
					reason: null,
					separator: SEP,
				}),
			).toEqual({ kind: "none" });
		});

		it("no visible label + reason → the reason becomes the accessible name", () => {
			expect(
				deriveTooltipText({
					visibleLabel: null,
					reason: "Close tab",
					separator: SEP,
				}),
			).toEqual({ kind: "text", text: "Close tab" });
		});

		it("neither → none", () => {
			expect(
				deriveTooltipText({
					visibleLabel: null,
					reason: null,
					separator: SEP,
				}),
			).toEqual({ kind: "none" });
		});
	});

	describe("whitespace-only inputs count as absent", () => {
		it("a blank reason does not produce a trailing separator", () => {
			expect(
				deriveTooltipText({
					visibleLabel: "Agent",
					reason: "   ",
					separator: SEP,
				}),
			).toEqual({ kind: "none" });
		});

		it("a blank visible label does not produce a leading separator", () => {
			expect(
				deriveTooltipText({
					visibleLabel: "  ",
					reason: "Cannot list sessions",
					separator: SEP,
				}),
			).toEqual({ kind: "text", text: "Cannot list sessions" });
		});

		it("surrounding whitespace is trimmed out of the composition", () => {
			expect(
				deriveTooltipText({
					visibleLabel: "  Agent  ",
					reason: "  offline  ",
					separator: SEP,
				}),
			).toEqual({ kind: "text", text: "Agent — offline" });
		});
	});

	describe("no double-labelling", () => {
		it("a reason that already contains the visible label is used as-is", () => {
			// The real shape from SessionHistoryModal: the pill's visible text is
			// the agent name, and the catalog string already embeds it.
			expect(
				deriveTooltipText({
					visibleLabel: "Claude Code",
					reason: "Agent server sessions (Claude Code)",
					separator: SEP,
				}),
			).toEqual({
				kind: "text",
				text: "Agent server sessions (Claude Code)",
			});
		});

		it("an identical label and reason do not repeat", () => {
			expect(
				deriveTooltipText({
					visibleLabel: "Retry",
					reason: "Retry",
					separator: SEP,
				}),
			).toEqual({ kind: "text", text: "Retry" });
		});
	});

	describe("locale-dependent separator", () => {
		it("uses a full-width separator when the catalog supplies one", () => {
			// ja/zh localize punctuation — their catalogs already use full-width
			// （）where English uses (). The separator is an input precisely so a
			// locale can override it; nothing here may hardcode " — ".
			expect(
				deriveTooltipText({
					visibleLabel: "エージェント",
					reason: "セッション一覧を取得できません",
					separator: "：",
				}),
			).toEqual({
				kind: "text",
				text: "エージェント：セッション一覧を取得できません",
			});
		});

		it("an empty separator still joins both parts", () => {
			// Degenerate but must not throw or silently drop a side.
			const result = deriveTooltipText({
				visibleLabel: "A",
				reason: "B",
				separator: "",
			});
			expect(result).toEqual({ kind: "text", text: "AB" });
		});
	});

	describe("totality", () => {
		it("never throws across the whole input cross-product", () => {
			const values = [null, "", "   ", "Label", "Label — with sep"];
			const separators = ["", " — ", "：", "\n"];
			for (const visibleLabel of values) {
				for (const reason of values) {
					for (const separator of separators) {
						expect(() =>
							deriveTooltipText({
								visibleLabel,
								reason,
								separator,
							}),
						).not.toThrow();
					}
				}
			}
		});

		it("never returns text that is empty or pure whitespace", () => {
			// A `{kind:"text"}` with blank text would set an empty aria-label,
			// which strips the element's accessible name entirely — worse than
			// no tooltip. `none` is the correct outcome for that case.
			const values = [null, "", "   ", "Label"];
			for (const visibleLabel of values) {
				for (const reason of values) {
					const out = deriveTooltipText({
						visibleLabel,
						reason,
						separator: SEP,
					});
					if (out.kind === "text") {
						expect(out.text.trim()).not.toBe("");
					}
				}
			}
		});
	});
});
