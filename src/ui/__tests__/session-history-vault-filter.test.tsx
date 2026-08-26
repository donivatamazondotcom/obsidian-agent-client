/**
 * "Only this folder" cwd filter — universal, default-off, conditional, with
 * folder transparency (item g / I147).
 *
 * Contract after I147:
 *  - Universal: the filter is offered on BOTH the Local and Agent views (it is
 *    no longer Agent-only) and for every agent. cwd is a per-session fact, so
 *    the filter is meaningful everywhere.
 *  - Conditional: shown only when the library spans >1 distinct working folder
 *    (mirrors the agent-badge ">1 agent" rule), so a single-folder library
 *    never sees an inert control. Stays visible while active.
 *  - Default OFF: history opens unfiltered ("whole history"); the user opts in.
 *  - Transparency: the real working-folder path is rendered as visible text
 *    (reachable by screen readers, not tooltip-only).
 *  - Narrowing: the live Agent view narrows server-side (refetch with the cwd);
 *    the Local view narrows client-side (no refetch).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App } from "obsidian";
import { SessionHistoryContent } from "../SessionHistoryModal";
import type { SessionInfo } from "../../types/session";

const CLAUDE_CAPS = {
	listsSessions: true,
	restoresViaLoad: true,
	restoresViaResume: false,
	forks: true,
	reportsModels: false,
};

const VAULT_A = "/Users/me/vault-A";
const VAULT_B = "/Users/me/vault-B";

function row(sessionId: string, title: string, cwd: string): SessionInfo {
	return { sessionId, cwd, title, updatedAt: "2026-06-28T00:00:00Z", agentId: "claude" };
}

const TWO_FOLDERS = [row("a1", "alpha", VAULT_A), row("b1", "beta", VAULT_B)];
const ONE_FOLDER = [row("a1", "alpha", VAULT_A), row("a2", "alpha2", VAULT_A)];

function makeProps(
	overrides: Partial<Parameters<typeof SessionHistoryContent>[0]> = {},
): Parameters<typeof SessionHistoryContent>[0] {
	return {
		app: new App(),
		sessions: TWO_FOLDERS,
		loading: false,
		error: null,
		hasMore: false,
		currentCwd: VAULT_A,
		loadSessionMessages: vi.fn(async () => null),
		capabilities: CLAUDE_CAPS,
		localSessionIds: new Set<string>(),
		isAgentReady: true,
		debugMode: false,
		initialSource: "agent",
		agentSessionCache: null,
		agentLabels: { claude: "Claude Code" },
		currentAgentLabel: "Claude Code",
		onRestoreSession: vi.fn(async () => {}),
		onForkSession: vi.fn(async () => {}),
		onDeleteSession: vi.fn(),
		onEditTitle: vi.fn(),
		onLoadMore: vi.fn(),
		onFetchSessions: vi.fn(),
		onSourceChange: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
}

describe('"Only this folder" filter — visibility (conditional on >1 folder)', () => {
	afterEach(cleanup);

	it("is hidden when the library spans a single folder (even on the Agent view)", () => {
		render(<SessionHistoryContent {...makeProps({ sessions: ONE_FOLDER })} />);
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByText("Only this folder")).toBeNull();
	});

	it("is shown on the Agent view when the library spans >1 folder", () => {
		render(<SessionHistoryContent {...makeProps()} />);
		expect(screen.getByText("Only this folder")).toBeTruthy();
	});

	it("is shown on the Local view too when the library spans >1 folder (universal, not Agent-only)", () => {
		render(<SessionHistoryContent {...makeProps({ initialSource: "local" })} />);
		expect(screen.getByText("Only this folder")).toBeTruthy();
	});
});

describe('"Only this folder" filter — default + transparency', () => {
	afterEach(cleanup);

	it("defaults to unchecked (history opens unfiltered)", () => {
		render(<SessionHistoryContent {...makeProps()} />);
		expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
	});

	it("renders the real working-folder path as visible text (transparency, not tooltip-only)", () => {
		render(<SessionHistoryContent {...makeProps()} />);
		// VAULT_A is the currentCwd; it appears only in the filter's folder line
		// (per-row cwds render only when they differ from currentCwd).
		expect(screen.getByText(VAULT_A)).toBeTruthy();
	});
});

describe('"Only this folder" filter — tooltip placement (I199)', () => {
	afterEach(cleanup);

	it("puts the explanation on the checkbox, not the <label>", () => {
		render(<SessionHistoryContent {...makeProps({ sessions: TWO_FOLDERS })} />);
		const checkbox = screen.getByRole("checkbox");

		// A <label>'s text content is what names its control, so an aria-label
		// on the LABEL element can make assistive tech name the checkbox with
		// the long explanation instead of "Only this folder". It belongs on the
		// input.
		const label = checkbox.closest("label");
		expect(label).not.toBeNull();
		expect(label!.hasAttribute("aria-label")).toBe(false);
		expect(label!.hasAttribute("title")).toBe(false);

		// No DOM `title` anywhere in the filter — that rendered an OS-native
		// tooltip, inconsistent with every other tooltip in the app.
		expect(checkbox.hasAttribute("title")).toBe(false);
	});

	it("keeps the visible label at the front of the composed tooltip", () => {
		render(<SessionHistoryContent {...makeProps({ sessions: TWO_FOLDERS })} />);
		const aria = screen.getByRole("checkbox").getAttribute("aria-label");
		// Label-in-name: the tooltip doubles as the accessible name, so the
		// visible text has to survive into it — followed by the explanation.
		expect(aria).toMatch(/^Only this folder — /);
		expect(aria).toMatch(/working folder is this one/);
	});
});

describe('"Only this folder" filter — live Agent view narrows server-side', () => {
	afterEach(cleanup);

	it("checking narrows the fetch to the current folder; unchecking broadens to every folder", () => {
		const onFetchSessions = vi.fn();
		render(<SessionHistoryContent {...makeProps({ onFetchSessions })} />);
		const checkbox = screen.getByRole("checkbox");
		fireEvent.click(checkbox); // unchecked → checked (narrow)
		expect(onFetchSessions).toHaveBeenLastCalledWith("agent", VAULT_A);
		fireEvent.click(checkbox); // checked → unchecked (broaden)
		expect(onFetchSessions).toHaveBeenLastCalledWith("agent", undefined);
	});
});

describe('"Only this folder" filter — Local view narrows client-side (no refetch)', () => {
	afterEach(cleanup);

	it("checking hides rows from other folders without calling onFetchSessions", () => {
		const onFetchSessions = vi.fn();
		render(
			<SessionHistoryContent
				{...makeProps({ initialSource: "local", onFetchSessions })}
			/>,
		);
		// Default off: both folders' sessions visible.
		expect(screen.getByText("alpha")).toBeTruthy();
		expect(screen.getByText("beta")).toBeTruthy();

		fireEvent.click(screen.getByRole("checkbox")); // narrow to VAULT_A
		expect(screen.getByText("alpha")).toBeTruthy(); // VAULT_A row stays
		expect(screen.queryByText("beta")).toBeNull(); // VAULT_B row filtered out
		// Local narrows client-side — no server refetch.
		expect(onFetchSessions).not.toHaveBeenCalled();
	});
});
