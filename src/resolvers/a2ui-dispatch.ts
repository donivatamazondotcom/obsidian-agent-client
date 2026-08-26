/**
 * a2ui-dispatch — the ONE tab-level decision for what activating an
 * agent-emitted surface control would do (A2UI-I08).
 *
 * Read by BOTH sides of the interaction:
 *   - the renderer, through `deriveSurfaceActionAffordance`, which layers the
 *     per-surface reasons (answered / pending / superseded / streaming) on top;
 *   - the dispatch path, `SessionDispatchPort`, which acts on it.
 *
 * That shared read is the point. Before this resolver existed the renderer
 * ignored session liveness while the port required `ready`, so a restored tab
 * rendered live buttons that refused on click ("try again when the agent is
 * idle"). A tagged union makes the illegal "enabled but nothing to dispatch"
 * combination unrepresentable rather than merely tested.
 *
 * Revises D7 of [[Agent Console Agent-Emitted Interactive Prompts]] ("actions
 * never lazily acquire"): a click on a disconnected tab is unambiguous intent,
 * so it acquires and the action is held for connect-flush delivery — the same
 * path a composer send takes on an idle tab. Per the repo tenet, gate on
 * intent and data availability, not on connection state.
 */
import type { TabSessionState } from "../types/tab";

/** Refusal reasons decidable from tab state alone (no surface context). */
export type A2uiTabRefuseReason =
	| "sending"
	| "permission"
	| "queued"
	| "restoring";

/**
 * What activating a control would DO.
 *  - `sendNow`        — live, idle session: dispatch immediately.
 *  - `acquireAndSend` — no live session: reconnect, then deliver.
 *  - `refuse`         — not dispatchable; the reason carries plain-language copy.
 */
export type A2uiTabDispatchMode =
	| { kind: "sendNow" }
	| { kind: "acquireAndSend" }
	| { kind: "refuse"; reason: A2uiTabRefuseReason };

export interface A2uiTabDispatchInput {
	/** Per-tab session lifecycle state. */
	sessionState: TabSessionState;
	/** A turn is currently streaming in this tab. */
	isSending: boolean;
	/** The queue-of-one slot is occupied. */
	isQueued: boolean;
	/** Session history is being restored/loaded. */
	isRestoringSession: boolean;
}

export function deriveA2uiTabDispatch(
	input: A2uiTabDispatchInput,
): A2uiTabDispatchMode {
	// A live turn anywhere in the tab blocks activation (actions never queue
	// behind a running turn — they disable in place with a reason).
	if (input.isSending) return { kind: "refuse", reason: "sending" };
	// Queue-of-one: the slot holds exactly one message, whoever asked first.
	// This outranks reconnect — a held message must not be displaced.
	if (input.isQueued) return { kind: "refuse", reason: "queued" };
	if (input.isRestoringSession) return { kind: "refuse", reason: "restoring" };
	switch (input.sessionState) {
		case "ready":
			return { kind: "sendNow" };
		case "busy":
			// Live turn without the isSending edge (e.g. a tool call in flight).
			return { kind: "refuse", reason: "sending" };
		case "permission":
			return { kind: "refuse", reason: "permission" };
		case "idle":
		case "connecting":
		case "error":
			// No live session: reconnect, then deliver.
			return { kind: "acquireAndSend" };
	}
}
