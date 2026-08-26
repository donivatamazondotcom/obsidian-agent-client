/**
 * A2UI-I08 — the queued banner must not misdescribe a HELD SURFACE ACTION as
 * queued composer text, and must not offer Delete for one.
 *
 * Why this file exists: the smoke drive (2026-08-25) found the banner still
 * reading "Queued — sends when ready" with Edit/Delete while a surface action
 * was held for reconnect. The resolver, port, and reducer were all correct and
 * green — `InputArea` had the `isQueuedAction` prop and `buildQueuedBanner` had
 * the branch, but ChatPanel never PASSED the prop. Every unit test stayed green
 * because none of them entered at the wiring seam.
 *
 * That is the "test the LIVE wiring, not just the pure function" rule (learned
 * rules § prompt-construction & tab-label changes) applied to a render prop.
 * So this file does two things:
 *
 *  1. Renders the REAL InputArea and asserts the rendered banner/actions — the
 *     behavior a user sees.
 *  2. Asserts ChatPanel actually forwards the prop, which is the only layer
 *     that can catch the specific miss above (same source-guard style as
 *     resolver-zone / styles-css-syntax / i18n-literal tests).
 *
 * Delete is the hazard, not a cosmetic detail: `deleteQueued` emits
 * `clearComposer`, so offering it for a held action puts an unrelated unsent
 * draft one click from destruction — the exact thing the detached-send port
 * (D8) exists to prevent.
 */

import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { InputArea, type InputAreaProps } from "../InputArea";
import type AgentClientPlugin from "../../plugin";
import type { IChatViewHost } from "../view-host";
import type { UseSuggestionsReturn } from "../../hooks/useSuggestions";

beforeAll(() => {
	class IO {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
		IO;
});

afterEach(cleanup);

const settingsSnapshot = { sendMessageShortcut: "enter" };

function makePlugin(): AgentClientPlugin {
	return {
		settings: { displaySettings: { showEmojis: false } },
		settingsService: {
			subscribe: () => () => {},
			getSnapshot: () => settingsSnapshot,
		},
		app: { vault: { getConfig: () => true } },
	} as unknown as AgentClientPlugin;
}

function closedSuggestions(): UseSuggestionsReturn {
	const closed = {
		isOpen: false,
		suggestions: [] as unknown[],
		selectedIndex: 0,
		createRow: null,
		updateSuggestions: () => undefined,
		close: () => undefined,
		selectSuggestion: (v: string) => ({ newText: v, newCursorPos: v.length }),
	};
	return {
		mentions: closed,
		commands: closed,
		quickPrompts: closed,
		activePicker: null,
	} as unknown as UseSuggestionsReturn;
}

function baseProps(overrides: Partial<InputAreaProps>): InputAreaProps {
	return {
		isSending: false,
		isSessionReady: false,
		lazyState: "connecting",
		isRestoringSession: false,
		agentLabel: "Claude Code",
		availableCommands: [],
		restoredMessage: null,
		suggestions: closedSuggestions(),
		plugin: makePlugin(),
		view: {} as IChatViewHost,
		onSendMessage: vi.fn(async () => undefined),
		onStopGeneration: vi.fn(async () => undefined),
		onRestoredMessageConsumed: () => undefined,
		supportsImages: false,
		imageCapabilityKnown: true,
		agentId: "claude-code-acp",
		inputValue: "DRAFT-MUST-SURVIVE",
		onInputChange: () => undefined,
		attachedFiles: [],
		onAttachedFilesChange: () => undefined,
		errorInfo: null,
		onClearError: () => undefined,
		agentUpdateNotification: null,
		onClearAgentUpdate: () => undefined,
		messages: [],
		isActive: true,
		...overrides,
	};
}

function bannerOf(container: HTMLElement): {
	text: string | null;
	actions: string[];
} {
	return {
		text:
			container.querySelector(".agent-client-queued-banner-text")
				?.textContent ?? null,
		actions: Array.from(
			container.querySelectorAll(
				".agent-client-queued-banner-actions button",
			),
		).map((b) => b.textContent ?? ""),
	};
}

describe("InputArea — held surface action vs queued composer text", () => {
	it("a held ACTION never offers Delete (it would clear the composer)", () => {
		const { container } = render(
			<InputArea {...baseProps({ isQueued: true, isQueuedAction: true })} />,
		);
		const { text, actions } = bannerOf(container);
		expect(actions).not.toContain("Delete");
		expect(actions).toHaveLength(1);
		// ...and the copy must not claim the user's draft is queued.
		expect(text).not.toBe("Queued — sends when ready");
		expect(text).toMatch(/your choice/i);
	});

	it("queued composer TEXT still offers Edit and Delete (regression guard)", () => {
		const { container } = render(
			<InputArea {...baseProps({ isQueued: true })} />,
		);
		const { text, actions } = bannerOf(container);
		expect(actions).toEqual(["Edit", "Delete"]);
		expect(text).toBe("Queued — sends when ready");
	});

	it("no banner at all when nothing is queued", () => {
		const { container } = render(<InputArea {...baseProps({})} />);
		expect(bannerOf(container).text).toBeNull();
	});
});

describe("A2UI-I08 wiring guard — ChatPanel forwards isQueuedAction", () => {
	it("passes the detached-action flag into InputArea", () => {
		const source = readFileSync(
			resolve(process.cwd(), "src/ui/ChatPanel.tsx"),
			"utf8",
		);
		// The miss the smoke drive caught: prop declared + branch implemented,
		// but never handed down, so the banner silently stayed generic.
		expect(source).toMatch(/isQueuedAction=\{/);
		expect(source).toMatch(/detachedSurfaceId !== undefined/);
	});
});
