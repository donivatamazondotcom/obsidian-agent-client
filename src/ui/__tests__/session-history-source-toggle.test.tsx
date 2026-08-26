/**
 * SessionHistoryContent — Local/Agent source toggle, per-row agent badge,
 * migration empty-state, and the disconnected-Agent sync affordance
 * (Session History Source Model, Track 1).
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
const KIRO_CAPS = {
	listsSessions: false,
	restoresViaLoad: false,
	restoresViaResume: true,
	forks: false,
	reportsModels: false,
};

function row(sessionId: string, title: string, agentId?: string): SessionInfo {
	return {
		sessionId,
		cwd: "/vault",
		title,
		updatedAt: "2026-06-28T00:00:00Z",
		agentId,
	};
}

function makeProps(
	overrides: Partial<Parameters<typeof SessionHistoryContent>[0]> = {},
): Parameters<typeof SessionHistoryContent>[0] {
	return {
		app: new App(),
		sessions: [],
		loading: false,
		error: null,
		hasMore: false,
		currentCwd: "/vault",
		loadSessionMessages: vi.fn(async () => null),
		capabilities: CLAUDE_CAPS,
		localSessionIds: new Set<string>(),
		isAgentReady: true,
		debugMode: false,
		initialSource: "local",
		agentSessionCache: null,
		agentLabels: { claude: "Claude Code", kiro: "Kiro CLI" },
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

describe("SessionHistoryContent — Local/Agent toggle", () => {
	afterEach(cleanup);

	it("renders the toggle for a listing agent (Claude), labeling the Agent pill with the agent name (D2)", () => {
		render(<SessionHistoryContent {...makeProps()} />);
		expect(screen.getByRole("tab", { name: "Local" })).toBeTruthy();
		const agentPill = screen.getByRole("tab", { name: /Claude Code/ });
		expect(agentPill).toBeTruthy();
		expect((agentPill as HTMLButtonElement).disabled).toBe(false);
		// Enabled state names the pill without a second OS-native tooltip.
		expect(agentPill.getAttribute("aria-label")).toMatch(/Agent server sessions/);
		expect(agentPill.hasAttribute("title")).toBe(false);
	});

	it("always shows the toggle but disables the Agent pill for a non-listing agent (Kiro), with a tooltip (D3)", () => {
		render(
			<SessionHistoryContent
				{...makeProps({
					capabilities: KIRO_CAPS,
					currentAgentLabel: "Kiro CLI",
				})}
			/>,
		);
		const agentPill = screen.getByRole("tab", { name: /Kiro CLI/ });
		expect((agentPill as HTMLButtonElement).disabled).toBe(true);

		// ONE tooltip, via Obsidian's mechanism (aria-label). This pill used to
		// carry aria-label AND a DOM `title`, so a non-listing agent rendered
		// two tooltips saying different things (I200).
		expect(agentPill.getAttribute("aria-label")).toMatch(
			/doesn't keep a session list/,
		);
		expect(agentPill.hasAttribute("title")).toBe(false);
		// WCAG 2.5.3 label-in-name: the tooltip doubles as the accessible name,
		// so it must still contain the pill's visible text. Losing this is the
		// exact regression A2UI-I08 shipped.
		expect(agentPill.textContent).toContain("Kiro CLI");
		expect(agentPill.getAttribute("aria-label")).toContain("Kiro CLI");
		// Local pill is still there and active.
		expect(
			screen
				.getByRole("tab", { name: "Local" })
				.getAttribute("aria-selected"),
		).toBe("true");
	});

	it("clicking the Agent pill persists the choice and refetches unfiltered (filter defaults off — I147)", () => {
		const onSourceChange = vi.fn();
		const onFetchSessions = vi.fn();
		render(
			<SessionHistoryContent
				{...makeProps({ onSourceChange, onFetchSessions })}
			/>,
		);
		fireEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
		expect(onSourceChange).toHaveBeenCalledWith("agent");
		// Default-off filter → the Agent view opens unfiltered (every folder).
		expect(onFetchSessions).toHaveBeenCalledWith("agent", undefined);
	});

	it("defaults the Local pill active", () => {
		render(<SessionHistoryContent {...makeProps()} />);
		expect(
			screen.getByRole("tab", { name: "Local" }).getAttribute("aria-selected"),
		).toBe("true");
	});

	it("does not gate the folder filter on source (I147: data-gated, not source-gated) — hidden on the Agent view too when the library has ≤1 folder", () => {
		render(
			<SessionHistoryContent {...makeProps({ initialSource: "agent" })} />,
		);
		// makeProps has an empty library (≤1 folder) → no folder filter, either source.
		expect(screen.queryByText("Only this folder")).toBeNull();
		expect(screen.queryByText("This vault only")).toBeNull();
	});
});

describe("SessionHistoryContent — fork action (D1)", () => {
	afterEach(cleanup);

	it("renders the fork icon on a Local row and calls onForkSession with the row's id + cwd", () => {
		const onForkSession = vi.fn(async () => {});
		render(
			<SessionHistoryContent
				{...makeProps({
					sessions: [row("c1", "a claude session", "claude")],
					onForkSession,
				})}
			/>,
		);
		const forkBtn = screen.getByRole("button", {
			name: "Fork session into a new tab",
		});
		fireEvent.click(forkBtn);
		expect(onForkSession).toHaveBeenCalledWith("c1", "/vault");
	});

	it("offers fork on a non-fork-capable agent too (agent-agnostic, RC-2)", () => {
		render(
			<SessionHistoryContent
				{...makeProps({
					capabilities: KIRO_CAPS,
					currentAgentLabel: "Kiro CLI",
					sessions: [row("k1", "a kiro session", "kiro")],
				})}
			/>,
		);
		expect(
			screen.getByRole("button", {
				name: "Fork session into a new tab",
			}),
		).toBeTruthy();
	});
});

describe("SessionHistoryContent — per-row agent badge (D: only when >1 agent)", () => {
	afterEach(cleanup);

	it("hides the agent badge in a single-agent library (avoids redundant noise)", () => {
		render(
			<SessionHistoryContent
				{...makeProps({
					sessions: [
						row("c1", "a claude session", "claude"),
						row("c2", "another claude session", "claude"),
					],
				})}
			/>,
		);
		// All rows share one agent → the badge would duplicate the source pill,
		// so it is suppressed.
		expect(screen.queryByLabelText("Agent: Claude Code")).toBeNull();
	});

	it("shows agent badges when the library spans more than one agent", () => {
		render(
			<SessionHistoryContent
				{...makeProps({
					sessions: [
						row("c1", "a claude session", "claude"),
						row("k1", "a kiro session", "kiro"),
					],
				})}
			/>,
		);
		// Query by aria-label so the badges aren't confused with the Agent pill.
		expect(screen.getByLabelText("Agent: Claude Code")).toBeTruthy();
		expect(screen.getByLabelText("Agent: Kiro CLI")).toBeTruthy();
	});
});

describe("SessionHistoryContent — migration empty-state", () => {
	afterEach(cleanup);

	it("points to the Agent view when Local is empty and the agent can list", () => {
		render(
			<SessionHistoryContent
				{...makeProps({
					sessions: [],
					agentSessionCache: {
						sessions: [
							{ sessionId: "s1", cwd: "/vault", title: "x" },
							{ sessionId: "s2", cwd: "/vault", title: "y" },
						],
						syncedAt: "2026-06-28T00:00:00Z",
					},
				})}
			/>,
		);
		expect(
			screen.getByText(/No local sessions yet\. Your agent has 2/),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "View agent sessions" }),
		).toBeTruthy();
	});

	it("shows the plain empty message for a non-listing agent (no migration prompt)", () => {
		render(
			<SessionHistoryContent
				{...makeProps({ sessions: [], capabilities: KIRO_CAPS })}
			/>,
		);
		expect(screen.getByText("No previous sessions")).toBeTruthy();
		expect(screen.queryByText(/view them under Agent/)).toBeNull();
	});
});

describe("SessionHistoryContent — disconnected Agent view (cache + affordance)", () => {
	afterEach(cleanup);

	it("renders cached rows + a 'connect to refresh' affordance when not ready", () => {
		render(
			<SessionHistoryContent
				{...makeProps({
					initialSource: "agent",
					isAgentReady: false,
					agentSessionCache: {
						sessions: [
							{ sessionId: "srv1", cwd: "/vault", title: "server row" },
						],
						syncedAt: "2026-06-28T00:00:00Z",
					},
				})}
			/>,
		);
		expect(
			screen.getByText("Send a message to reconnect and refresh"),
		).toBeTruthy();
		expect(screen.getByText(/^Synced /)).toBeTruthy();
		expect(screen.getByText("server row")).toBeTruthy();
	});

	it("prompts to connect when there is no cache yet", () => {
		render(
			<SessionHistoryContent
				{...makeProps({
					initialSource: "agent",
					isAgentReady: false,
					agentSessionCache: null,
				})}
			/>,
		);
		expect(
			screen.getByText(/Send a message to connect/),
		).toBeTruthy();
	});
});
