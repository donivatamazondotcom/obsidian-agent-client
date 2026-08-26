/**
 * Tooltip text — the one place that decides what an element's tooltip says.
 *
 * Obsidian's `setTooltip(el, text)` is implemented by setting **`aria-label`**
 * (verified against the running app 2026-08-25). So a tooltip is not decoration:
 * it is simultaneously the element's accessible name. That single fact drives
 * every rule below.
 *
 * The consequence is WCAG 2.5.3 label-in-name. When an element already shows
 * visible text, its accessible name must still contain that text — otherwise a
 * speech-input user who says the words they can see cannot activate the control.
 * So a tooltip that only carries an *explanation* silently replaces the name
 * with something the user can't see. Composing `<label><sep><reason>` keeps
 * both. Leaving that composition to each call site is what produced the
 * regression this resolver exists to prevent (A2UI-I08).
 *
 * Why a tagged union rather than `string | undefined`: "no tooltip" is a real
 * outcome with a real action attached — any tooltip a previous render left on
 * the element has to be REMOVED, not merely skipped. `undefined` invites the
 * caller to do nothing and leave a stale tooltip behind, which is the bug
 * A2uiSurfaceHost's explicit `removeAttribute` pair was working around inline.
 *
 * Pure and total: no React, no Obsidian, no `t()`. The separator arrives as an
 * input because it is locale-dependent (`ja`/`zh` localize punctuation — their
 * catalogs use full-width `（）` where English uses `()`), and reading the
 * catalog is the imperative shell's job. See `ui/shared/useTooltip.ts`.
 */

/** What a tooltip should be set to, or that it must be cleared. */
export type TooltipText =
	| { kind: "none" }
	| { kind: "text"; text: string };

export interface TooltipTextInput {
	/**
	 * The element's own visible text, or null when it has none (an icon-only
	 * control). This is the label-in-name anchor — when present it must survive
	 * into the composed tooltip.
	 */
	visibleLabel: string | null;
	/**
	 * The extra information the tooltip exists to convey: why a control is
	 * disabled, what a dropdown selects, what a truncated label says in full.
	 * Null when there is nothing to add beyond the visible text.
	 */
	reason: string | null;
	/** Locale-appropriate glue between label and reason, e.g. `" — "`. */
	separator: string;
}

/** Treat whitespace-only strings as absent — a blank catalog value is not a label. */
function present(value: string | null): string | null {
	if (value === null) return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * Decide an element's tooltip text.
 *
 * | visible label | reason  | result                                            |
 * |---------------|---------|---------------------------------------------------|
 * | yes           | yes     | `label<sep>reason` — keeps label-in-name          |
 * | yes           | no      | `none` — visible text already names it; a tooltip |
 * |               |         | repeating it is noise                             |
 * | no            | yes     | `reason` — icon-only control; the reason IS its   |
 * |               |         | accessible name                                   |
 * | no            | no      | `none` — nothing to say                           |
 */
export function deriveTooltipText(input: TooltipTextInput): TooltipText {
	const label = present(input.visibleLabel);
	const reason = present(input.reason);

	if (reason === null) {
		// Nothing to add. Either the visible text already names the element, or
		// there is no text at all — in both cases any previous tooltip is stale.
		return { kind: "none" };
	}

	if (label === null) {
		return { kind: "text", text: reason };
	}

	// Don't double up when the reason already opens with the visible label
	// (some catalog strings are written self-contained, e.g.
	// "Agent server sessions ({agent})" against a visible "{agent}").
	if (reason.includes(label)) {
		return { kind: "text", text: reason };
	}

	return { kind: "text", text: `${label}${input.separator}${reason}` };
}
