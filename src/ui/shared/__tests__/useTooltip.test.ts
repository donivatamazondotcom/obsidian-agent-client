/**
 * `attachTooltip` / `tooltipRef` / `useTooltip` — the imperative shell around
 * `deriveTooltipText`.
 *
 * The resolver's truth table is covered in
 * `src/resolvers/__tests__/tooltip-text.test.ts`. What can only be asserted here
 * is the DOM side: that the sanctioned path actually reaches `setTooltip`, and
 * that "no tooltip" REMOVES a stale one rather than leaving it behind. The
 * second half is the reason the resolver returns a tagged union instead of
 * `string | undefined` — `undefined` invites a caller to skip the write and keep
 * showing a tooltip that has become wrong (the A2UI disabled→live transition).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import * as React from "react";
import { setTooltip } from "obsidian";
import { attachTooltip, tooltipRef, useTooltip } from "../useTooltip";

afterEach(() => {
	vi.mocked(setTooltip).mockClear();
});

function el(): HTMLElement {
	return document.createElement("button");
}

describe("attachTooltip", () => {
	it("routes text through Obsidian's setTooltip, composed with the visible label", () => {
		const target = el();
		attachTooltip(target, {
			visibleLabel: "Sonnet 4.5",
			reason: "Balanced speed and depth",
		});
		expect(setTooltip).toHaveBeenCalledWith(
			target,
			"Sonnet 4.5 — Balanced speed and depth",
		);
		// The stub mirrors the real implementation (aria-label), so the
		// accessible name is assertable as a rendered outcome, not just a call.
		expect(target.getAttribute("aria-label")).toBe(
			"Sonnet 4.5 — Balanced speed and depth",
		);
	});

	it("uses the reason alone for an icon-only control", () => {
		const target = el();
		attachTooltip(target, { visibleLabel: null, reason: "Close tab" });
		expect(target.getAttribute("aria-label")).toBe("Close tab");
	});

	it("clears a stale tooltip when there is nothing left to say", () => {
		const target = el();
		attachTooltip(target, { visibleLabel: "Send", reason: "Agent offline" });
		expect(target.getAttribute("aria-label")).toBe("Send — Agent offline");

		// The control came back online: the reason is gone, so the tooltip must
		// GO, not merely stop being updated.
		attachTooltip(target, { visibleLabel: "Send", reason: null });
		expect(target.hasAttribute("aria-label")).toBe(false);
		expect(target.hasAttribute("data-tooltip")).toBe(false);
	});

	it("clears Obsidian's cached data-tooltip attribute too", () => {
		const target = el();
		// Obsidian caches resolved tooltip state on the element; removing only
		// aria-label can leave the rendered tooltip alive.
		target.setAttribute("aria-label", "stale");
		target.setAttribute("data-tooltip", "stale");
		attachTooltip(target, { visibleLabel: null, reason: null });
		expect(target.hasAttribute("aria-label")).toBe(false);
		expect(target.hasAttribute("data-tooltip")).toBe(false);
	});

	it("never sets an empty accessible name", () => {
		const target = el();
		target.setAttribute("aria-label", "previous");
		// A blank reason must not produce aria-label="" — that strips the
		// element's accessible name entirely, which is worse than no tooltip.
		attachTooltip(target, { visibleLabel: "  ", reason: "   " });
		expect(target.hasAttribute("aria-label")).toBe(false);
		expect(setTooltip).not.toHaveBeenCalled();
	});

	it("is a no-op on a null element, so it drops into a ref callback", () => {
		expect(() =>
			attachTooltip(null, { visibleLabel: "x", reason: "y" }),
		).not.toThrow();
		expect(setTooltip).not.toHaveBeenCalled();
	});
});

describe("tooltipRef", () => {
	it("applies on mount and clears on unmount-style null", () => {
		const target = el();
		const ref = tooltipRef({ visibleLabel: "Agent", reason: "offline" });
		ref(target);
		expect(target.getAttribute("aria-label")).toBe("Agent — offline");
		expect(() => ref(null)).not.toThrow();
	});
});

describe("useTooltip", () => {
	it("applies the tooltip to an existing ref", () => {
		const target = el();
		const ref = React.createRef<HTMLElement>() as React.MutableRefObject<HTMLElement | null>;
		ref.current = target;
		renderHook(() =>
			useTooltip(ref, { visibleLabel: "Mode", reason: "Select mode" }),
		);
		expect(target.getAttribute("aria-label")).toBe("Mode — Select mode");
	});

	it("re-applies when the reason changes", () => {
		const target = el();
		const ref = React.createRef<HTMLElement>() as React.MutableRefObject<HTMLElement | null>;
		ref.current = target;
		const { rerender } = renderHook(
			({ reason }: { reason: string | null }) =>
				useTooltip(ref, { visibleLabel: "Send", reason }),
			{ initialProps: { reason: "Agent offline" as string | null } },
		);
		expect(target.getAttribute("aria-label")).toBe("Send — Agent offline");

		rerender({ reason: null });
		expect(target.hasAttribute("aria-label")).toBe(false);
	});
});
