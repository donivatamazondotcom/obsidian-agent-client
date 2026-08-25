/**
 * A2UI-I08 — clicking an active surface button on a NOT-CONNECTED tab must
 * reconnect and deliver the action, not refuse with "try again when the agent
 * is idle".
 *
 * Two defects are pinned here:
 *
 * 1. **The drift.** The render gate (`deriveSurfaceActionAffordance`) never
 *    considered session liveness, so on a restored/disconnected tab an
 *    unanswered surface rendered ENABLED — while the dispatch gate
 *    (`SessionDispatchPort.canSendNow`, `lazyState === "ready"`) refused. An
 *    enabled control that errors on click. The last test in this file is the
 *    structural guard: for EVERY tab state the two sides must agree.
 *
 * 2. **The refusal itself.** D7 ("actions never lazily acquire") is revised:
 *    a click on a disconnected tab is unambiguous intent, so it triggers
 *    acquisition and the action is held for connect-flush delivery — the same
 *    path a composer send takes on an idle tab.
 *
 * Queue-of-one still wins: an occupied slot refuses even when disconnected.
 */
import { describe, expect, it } from "vitest";
import { deriveSurfaceActionAffordance } from "../surface-state";
import {
	deriveA2uiTabDispatch,
	type A2uiTabDispatchInput,
} from "../../../resolvers/a2ui-dispatch";
import { createSessionDispatchPort } from "../../session-dispatch-port";
import type { SessionDispatchPortDeps } from "../../session-dispatch-port";
import {
	initialQueueState,
	isQueued,
	queueOrchestrationReducer,
} from "../../queue-orchestration-reducer";
import type { TabSessionState } from "../../../types/tab";

const ALL_TAB_STATES: readonly TabSessionState[] = [
	"idle",
	"connecting",
	"ready",
	"busy",
	"permission",
	"error",
];

/** Tab states with no live session — a click must acquire, not refuse. */
const NOT_CONNECTED: readonly TabSessionState[] = ["idle", "connecting", "error"];

function tabInput(
	overrides: Partial<A2uiTabDispatchInput> = {},
): A2uiTabDispatchInput {
	return {
		sessionState: "ready",
		isSending: false,
		isQueued: false,
		isRestoringSession: false,
		...overrides,
	};
}

// ============================================================================
// 1. The tab-level dispatch decision (shared by renderer and port)
// ============================================================================

describe("deriveA2uiTabDispatch", () => {
	it("dispatches immediately on a live, idle tab", () => {
		expect(deriveA2uiTabDispatch(tabInput()).kind).toBe("sendNow");
	});

	it.each(NOT_CONNECTED)(
		"acquires and sends when there is no live session (%s)",
		(sessionState) => {
			expect(
				deriveA2uiTabDispatch(tabInput({ sessionState })).kind,
			).toBe("acquireAndSend");
		},
	);

	it("refuses while a turn is streaming", () => {
		const mode = deriveA2uiTabDispatch(tabInput({ isSending: true }));
		expect(mode).toEqual({ kind: "refuse", reason: "sending" });
	});

	it("refuses while the agent is working (busy)", () => {
		expect(
			deriveA2uiTabDispatch(tabInput({ sessionState: "busy" })).kind,
		).toBe("refuse");
	});

	it("refuses while a permission decision is open", () => {
		expect(
			deriveA2uiTabDispatch(tabInput({ sessionState: "permission" })),
		).toEqual({ kind: "refuse", reason: "permission" });
	});

	it("refuses while session history is restoring", () => {
		expect(
			deriveA2uiTabDispatch(tabInput({ isRestoringSession: true })),
		).toEqual({ kind: "refuse", reason: "restoring" });
	});

	it.each(ALL_TAB_STATES)(
		"queue-of-one wins over reconnect: an occupied slot refuses (%s)",
		(sessionState) => {
			expect(
				deriveA2uiTabDispatch(tabInput({ sessionState, isQueued: true }))
					.kind,
			).toBe("refuse");
		},
	);
});

// ============================================================================
// 2. The surface-level affordance composes the tab decision
// ============================================================================

describe("deriveSurfaceActionAffordance — liveness", () => {
	const surface = {
		surfaceStatus: "unanswered" as const,
		isStreamingTurn: false,
		isSuperseded: false,
	};

	it.each(NOT_CONNECTED)(
		"stays ENABLED on a disconnected tab (%s) and reports the reconnect mode",
		(sessionState) => {
			const affordance = deriveSurfaceActionAffordance({
				...surface,
				...tabInput({ sessionState }),
			});
			expect(affordance.enabled).toBe(true);
			expect(affordance.mode).toBe("acquireAndSend");
		},
	);

	it("still disables an already-answered surface on a disconnected tab", () => {
		const affordance = deriveSurfaceActionAffordance({
			...surface,
			surfaceStatus: "answered",
			...tabInput({ sessionState: "idle" }),
		});
		expect(affordance.enabled).toBe(false);
		expect(affordance.reason).toBe("answered");
	});

	it("still disables a superseded surface on a disconnected tab", () => {
		const affordance = deriveSurfaceActionAffordance({
			...surface,
			isSuperseded: true,
			...tabInput({ sessionState: "idle" }),
		});
		expect(affordance.enabled).toBe(false);
		expect(affordance.reason).toBe("superseded");
	});

	it("still disables while its own turn is streaming", () => {
		const affordance = deriveSurfaceActionAffordance({
			...surface,
			isStreamingTurn: true,
			...tabInput({ sessionState: "idle" }),
		});
		expect(affordance.enabled).toBe(false);
		expect(affordance.reason).toBe("streaming");
	});
});

// ============================================================================
// 3. The port holds the action for delivery instead of refusing
// ============================================================================

interface PortHarness {
	deps: SessionDispatchPortDeps;
	sent: string[];
	held: Array<{ text: string; surfaceId: string }>;
	notices: string[];
}

function makePort(sessionState: TabSessionState): PortHarness {
	const sent: string[] = [];
	const held: Array<{ text: string; surfaceId: string }> = [];
	const notices: string[] = [];
	const deps: SessionDispatchPortDeps = {
		lazyState: () => sessionState,
		isSending: () => false,
		isQueued: () => false,
		isRestoringSession: () => false,
		sendMessage: async (text: string) => {
			sent.push(text);
		},
		holdForAcquisition: (text: string, surfaceId: string) => {
			held.push({ text, surfaceId });
		},
		notify: (message: string) => {
			notices.push(message);
		},
	};
	return { deps, sent, held, notices };
}

describe("SessionDispatchPort — reconnect-and-send", () => {
	it("sends immediately when the session is live", async () => {
		const h = makePort("ready");
		const outcome = await createSessionDispatchPort(h.deps).sendDetached(
			"Selected: A",
			"scope-7f3a",
		);
		expect(outcome).toBe("sent");
		expect(h.sent).toEqual(["Selected: A"]);
		expect(h.held).toEqual([]);
	});

	it.each(NOT_CONNECTED)(
		"holds the action for acquisition on a disconnected tab (%s) — no error notice",
		async (sessionState) => {
			const h = makePort(sessionState);
			const outcome = await createSessionDispatchPort(h.deps).sendDetached(
				"Selected: A",
				"scope-7f3a",
			);
			expect(outcome).toBe("held");
			// Held for connect-flush, never pushed through the raw send (which
			// would dispatch into a dead session).
			expect(h.sent).toEqual([]);
			expect(h.held).toEqual([
				{ text: "Selected: A", surfaceId: "scope-7f3a" },
			]);
			// The whole point of A2UI-I08: no "try again when the agent is idle".
			expect(h.notices).toEqual([]);
		},
	);
});

// ============================================================================
// 4. Structural anti-drift guard
// ============================================================================

describe("A2UI-I08 anti-drift: render gate and dispatch gate agree", () => {
	it.each(ALL_TAB_STATES)(
		"an enabled button always has a dispatchable port (%s)",
		(sessionState) => {
			const affordance = deriveSurfaceActionAffordance({
				surfaceStatus: "unanswered",
				isStreamingTurn: false,
				isSuperseded: false,
				...tabInput({ sessionState }),
			});
			const port = createSessionDispatchPort(makePort(sessionState).deps);
			// This equality is the invariant the bug violated: the surface
			// rendered enabled while the port refused.
			expect(affordance.enabled).toBe(port.canSendNow());
		},
	);
});

// ============================================================================
// 5. Queue reducer: a held ACTION must not touch the composer, and must not
//    strand the surface if reconnecting fails.
// ============================================================================

describe("A2UI-I08 queue reducer — detached actions", () => {
	const action = {
		content: '```a2ui\n{"action":{"surfaceId":"scope-7f3a"}}\n```',
		detachedSurfaceId: "scope-7f3a",
	};
	const typed = { content: "a draft the user typed" };

	it("holds the action and asks for acquisition", () => {
		const result = queueOrchestrationReducer(initialQueueState, {
			type: "sendWhilePreReady",
			message: action,
		});
		expect(result.state.pending).toEqual(action);
		expect(result.effects).toEqual([{ kind: "acquire" }]);
	});

	it("delivers on connect WITHOUT clearing the composer (D8: draft survives)", () => {
		const held = queueOrchestrationReducer(initialQueueState, {
			type: "sendWhilePreReady",
			message: action,
		}).state;
		const flushed = queueOrchestrationReducer(held, {
			type: "acquisitionComplete",
			hasSessionId: true,
		});
		expect(flushed.effects).toEqual([
			{ kind: "flushDispatch", message: action },
		]);
		// The regression this pins: a clearComposer here wipes an unsent draft
		// the user never queued.
		expect(
			flushed.effects.some((e) => e.kind === "clearComposer"),
		).toBe(false);
		expect(flushed.state.pending).toBeNull();
	});

	it("still clears the composer when the flushed message IS composer text", () => {
		const held = queueOrchestrationReducer(initialQueueState, {
			type: "sendWhilePreReady",
			message: typed,
		}).state;
		const flushed = queueOrchestrationReducer(held, {
			type: "acquisitionComplete",
			hasSessionId: true,
		});
		expect(flushed.effects).toEqual([
			{ kind: "clearComposer" },
			{ kind: "flushDispatch", message: typed },
		]);
	});

	it("releases the slot when reconnecting fails — no stuck surface, no blocked composer", () => {
		const held = queueOrchestrationReducer(initialQueueState, {
			type: "sendWhilePreReady",
			message: action,
		}).state;
		const failed = queueOrchestrationReducer(held, {
			type: "acquisitionFailed",
		});
		expect(failed.state.pending).toBeNull();
		expect(isQueued(failed.state)).toBe(false);
	});

	it("still HOLDS composer text when acquisition fails (unchanged behavior)", () => {
		const held = queueOrchestrationReducer(initialQueueState, {
			type: "sendWhilePreReady",
			message: typed,
		}).state;
		const failed = queueOrchestrationReducer(held, {
			type: "acquisitionFailed",
		});
		expect(failed.state.pending).toEqual(typed);
	});

	it("queue-of-one holds: a typed message cannot displace a held action", () => {
		const held = queueOrchestrationReducer(initialQueueState, {
			type: "sendWhilePreReady",
			message: action,
		}).state;
		const second = queueOrchestrationReducer(held, {
			type: "sendWhilePreReady",
			message: typed,
		});
		expect(second.state.pending).toEqual(action);
		expect(second.effects).toEqual([]);
	});
});
