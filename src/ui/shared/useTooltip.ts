/**
 * The one sanctioned way to put a tooltip on an element.
 *
 * Before this existed, three mechanisms coexisted with nothing ranking them:
 * `setTooltip()` from `obsidian`, a hand-written `aria-label`, and the DOM
 * `title` attribute. The first two are the SAME mechanism — `setTooltip`'s
 * implementation IS `aria-label` (verified against the running app 2026-08-25)
 * — which is why nobody noticed the third renders a different, OS-native
 * tooltip. Any element carrying `title` plus either of the others showed two
 * tooltips (I199). The `title` attribute is now an ESLint error
 * (`eslint.config.mjs`, guarded by `src/__tests__/title-attribute-ban.test.ts`),
 * and this module is the affordance that makes the sanctioned path the easy one.
 *
 * It owns the two things call sites kept getting wrong:
 *
 *  1. **Label-in-name composition.** Because the tooltip is also the accessible
 *     name, tooltip text on an element with visible text must still contain that
 *     text (WCAG 2.5.3). The decision lives in `deriveTooltipText`; call sites
 *     pass the label and the reason separately and never concatenate.
 *  2. **Clearing a stale tooltip.** When there is nothing to say, the previous
 *     render's tooltip has to be removed, not merely skipped. `setTooltip` has
 *     no "unset" call, so both attributes it writes are removed explicitly.
 *
 * The locale lookup lives here rather than in the resolver so the resolver stays
 * pure: the separator between label and reason is a catalog value
 * (`chat.tooltipSeparator`) because punctuation is localized — ja/zh use
 * full-width forms where English uses ASCII.
 */
import * as React from "react";
const { useEffect } = React;
import { setTooltip } from "obsidian";
import { t } from "../../i18n";
import {
	deriveTooltipText,
	type TooltipTextInput,
} from "../../resolvers/tooltip-text";

/** What a call site supplies: the two halves, never a pre-joined string. */
export type TooltipSpec = Omit<TooltipTextInput, "separator">;

/**
 * Apply (or clear) an element's tooltip. Safe to call with `null`, so it drops
 * straight into a React ref callback during unmount.
 */
export function attachTooltip(
	el: HTMLElement | null,
	spec: TooltipSpec,
): void {
	if (el === null) return;

	const decided = deriveTooltipText({
		...spec,
		separator: t("chat.tooltipSeparator"),
	});

	switch (decided.kind) {
		case "none":
			// setTooltip offers no way to unset. Obsidian's tooltip reads
			// aria-label and caches the resolved text on data-tooltip-position /
			// data-tooltip, so both have to go or a stale tooltip survives the
			// state change that made it wrong.
			el.removeAttribute("aria-label");
			el.removeAttribute("data-tooltip");
			return;
		case "text":
			setTooltip(el, decided.text);
			return;
	}
}

/**
 * Ref-callback form, for JSX that has no other use for a ref:
 *
 * ```tsx
 * <button ref={tooltipRef({ visibleLabel: label, reason: description })}>
 * ```
 *
 * Returns a fresh callback per render by design — React invokes it with the
 * element on every commit, which is what keeps the tooltip in step with a
 * changing `reason` (e.g. a control becoming disabled) without a dependency
 * array to forget.
 */
export function tooltipRef(
	spec: TooltipSpec,
): (el: HTMLElement | null) => void {
	return (el) => attachTooltip(el, spec);
}

/**
 * Hook form, for elements that already hold a ref for other reasons (focus
 * management, `setIcon`). Re-applies whenever either half of the text changes.
 */
export function useTooltip(
	ref: React.RefObject<HTMLElement | null>,
	spec: TooltipSpec,
): void {
	const { visibleLabel, reason } = spec;
	useEffect(() => {
		attachTooltip(ref.current, { visibleLabel, reason });
	}, [ref, visibleLabel, reason]);
}
