/**
 * ToolbarDropdown accessible name — label-in-name (I199).
 *
 * The mode / model dropdowns show the CURRENT option as visible text
 * ("Sonnet 4.5") while the tooltip carries that option's description. Until
 * I199 the component set `aria-label={title}` — the description alone — so the
 * accessible name was text the user could not see. A speech-input user saying
 * the words on screen could not activate the control (WCAG 2.5.3), and the
 * prop's name (`title`) actively invited writing the DOM `title` attribute,
 * which renders a second OS-native tooltip.
 *
 * Fails against the pre-fix component: the old aria-label was exactly the
 * description, so the `toContain(visible label)` assertions below did not hold.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as React from "react";

import { InputToolbar } from "../InputToolbar";
import type { SessionModelState, SessionModeState } from "../../types/session";

(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

// setTooltip must be present and behave like the real one (it sets aria-label)
// — that is the mechanism under test here.
vi.mock("obsidian", () => ({
	setIcon: vi.fn(),
	setTooltip: vi.fn((el: HTMLElement, text: string) => {
		el.setAttribute("aria-label", text);
	}),
	Menu: class {
		addItem() {
			return this;
		}
		showAtMouseEvent() {}
		showAtPosition() {}
	},
	MarkdownRenderer: { render: vi.fn() },
	Component: class {},
	Platform: { isMobile: false },
}));

const MODELS: SessionModelState = {
	availableModels: [
		{
			modelId: "sonnet-4-5",
			name: "Sonnet 4.5",
			description: "Balanced speed and depth",
		},
		{ modelId: "opus-5", name: "Opus 5", description: "Deepest reasoning" },
	],
	currentModelId: "sonnet-4-5",
} as unknown as SessionModelState;

const MODES: SessionModeState = {
	availableModes: [
		{ id: "ask", name: "Ask", description: "Answer without editing files" },
		{ id: "code", name: "Code", description: "Read and write files" },
	],
	currentModeId: "ask",
} as unknown as SessionModeState;

function renderToolbar(extra: Record<string, unknown> = {}) {
	return render(
		<InputToolbar
			isSending={false}
			isButtonDisabled={false}
			hasContent={true}
			onSendOrStop={vi.fn()}
			lazyState={{ kind: "ready" } as never}
			{...extra}
		/>,
	);
}

describe("ToolbarDropdown accessible name (I199)", () => {
	afterEach(cleanup);

	it("keeps the visible model name inside the accessible name", () => {
		renderToolbar({ models: MODELS, onModelChange: vi.fn() });
		const pill = screen.getByRole("button", { name: /Sonnet 4\.5/ });
		const aria = pill.getAttribute("aria-label");
		// Composed, not replaced: visible label first, then the description.
		expect(aria).toBe("Sonnet 4.5 — Balanced speed and depth");
		expect(pill.textContent).toContain("Sonnet 4.5");
	});

	it("keeps the visible mode name inside the accessible name", () => {
		renderToolbar({ modes: MODES, onModeChange: vi.fn() });
		const pill = screen.getByRole("button", { name: /Ask/ });
		expect(pill.getAttribute("aria-label")).toBe(
			"Ask — Answer without editing files",
		);
	});

	it("never sets the DOM title attribute", () => {
		renderToolbar({ models: MODELS, onModelChange: vi.fn() });
		// The prop is called `tooltip` now precisely so nobody reaches for the
		// attribute that renders a second, OS-native tooltip.
		const withTitle = document.querySelectorAll("[title]");
		expect(withTitle.length).toBe(0);
	});
});
