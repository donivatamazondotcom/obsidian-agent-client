import { describe, it, expect } from "vitest";
import {
	shouldFlushOnReady,
	decideConnectFlush,
} from "../message-queue-logic";
import {
	queueOrchestrationReducer,
	type QueueOrchestrationState,
} from "../queue-orchestration-reducer";
import type { QueuedMessage } from "../../types/chat";

/**
 * I103 — re-sent draft stuck queued when sessionId lags the ready edge.
 *
 * Symptom (studio smoke 2026-06-25, note #1): queue → reload (degrades to a
 * composer draft) → re-send → it re-queues + acquires → once the session is
 * established it never fires; it stays queued.
 *
 * Root cause: on the restored/loadSession path `agent.session.sessionId`
 * commits a render AFTER `lazySession.state -> "ready"`. The old connect-flush
 * keyed on the (connecting|idle)->ready EDGE + hasSessionId: it saw the edge
 * with hasSessionId=false (held), and when sessionId committed there was no
 * fresh edge -> never flushed.
 *
 * Classification: PRE-EXISTING (the old `shouldFlushOnReady` fails the lag
 * sequence identically — see the historical-gap test below), not a regression
 * from the queue reducer.
 *
 * Fix: `decideConnectFlush` arms an await flag on the acquisition edge and
 * dispatches once the lagging sessionId lands while still `ready`, staying
 * disjoint from the turn-end flush (busy->ready never arms the flag).
 */

const MSG: QueuedMessage = { content: "draft re-send" };

interface Render {
	lazyState: string;
	hasSessionId: boolean;
}

/** Restored/loadSession lag: ready commits a render BEFORE sessionId. */
const LAG: Render[] = [
	{ lazyState: "connecting", hasSessionId: false },
	{ lazyState: "ready", hasSessionId: false }, // acquisition edge, sessionId not yet
	{ lazyState: "ready", hasSessionId: true }, // sessionId commits — no fresh edge
];

/** Fresh tab: ready + sessionId commit together (why smoke (c) passed). */
const NO_LAG: Render[] = [
	{ lazyState: "connecting", hasSessionId: false },
	{ lazyState: "ready", hasSessionId: true },
];

/** Turn end on a live session: ready -> busy -> ready (must NOT connect-flush). */
const TURN_END: Render[] = [
	{ lazyState: "busy", hasSessionId: true },
	{ lazyState: "ready", hasSessionId: true },
];

/** The OLD connect-flush (edge + hasSessionId), for the historical-gap proof. */
function oldDelivers(seq: Render[]): boolean {
	let prev = "idle";
	for (const r of seq) {
		const flush = shouldFlushOnReady({
			prevState: prev,
			state: r.lazyState,
			hasSessionId: r.hasSessionId,
			isQueued: true,
		});
		prev = r.lazyState;
		if (flush) return true;
	}
	return false;
}

/** The FIXED connect-flush: decideConnectFlush -> reducer acquisitionComplete. */
function fixedDelivers(seq: Render[], initialPrev = "idle", pending = true): boolean {
	// I110: this is the PRE-READY/acquire path — the held message awaits
	// acquisition, so `acquisitionComplete` is its flush trigger (awaitingAcquire).
	let state: QueueOrchestrationState = {
		pending: pending ? MSG : null,
		awaitingAcquire: pending,
	};
	let prev = initialPrev;
	let awaiting = false;
	let delivered = 0;
	for (const r of seq) {
		const d = decideConnectFlush({
			prevState: prev,
			state: r.lazyState,
			hasSessionId: r.hasSessionId,
			awaitingSessionId: awaiting,
		});
		prev = r.lazyState;
		awaiting = d.awaitingSessionId;
		if (d.dispatchAcquisitionComplete) {
			const res = queueOrchestrationReducer(state, {
				type: "acquisitionComplete",
				hasSessionId: true,
			});
			state = res.state;
			if (res.effects.some((e) => e.kind === "flushDispatch")) delivered += 1;
		}
	}
	return delivered === 1;
}

describe("decideConnectFlush — pure transitions", () => {
	it("edge with sessionId → dispatch now", () => {
		expect(
			decideConnectFlush({
				prevState: "connecting",
				state: "ready",
				hasSessionId: true,
				awaitingSessionId: false,
			}),
		).toEqual({
			dispatchAcquisitionComplete: true,
			dispatchAcquisitionFailed: false,
			awaitingSessionId: false,
		});
	});

	it("edge without sessionId → arm await, no dispatch", () => {
		expect(
			decideConnectFlush({
				prevState: "connecting",
				state: "ready",
				hasSessionId: false,
				awaitingSessionId: false,
			}),
		).toEqual({
			dispatchAcquisitionComplete: false,
			dispatchAcquisitionFailed: false,
			awaitingSessionId: true,
		});
	});

	it("awaiting + sessionId commits while ready (no fresh edge) → dispatch", () => {
		expect(
			decideConnectFlush({
				prevState: "ready",
				state: "ready",
				hasSessionId: true,
				awaitingSessionId: true,
			}),
		).toEqual({
			dispatchAcquisitionComplete: true,
			dispatchAcquisitionFailed: false,
			awaitingSessionId: false,
		});
	});

	it("turn end (busy→ready) is NOT an acquisition edge → no dispatch (disjoint)", () => {
		expect(
			decideConnectFlush({
				prevState: "busy",
				state: "ready",
				hasSessionId: true,
				awaitingSessionId: false,
			}),
		).toEqual({
			dispatchAcquisitionComplete: false,
			dispatchAcquisitionFailed: false,
			awaitingSessionId: false,
		});
	});

	it("leaving ready clears the await flag", () => {
		expect(
			decideConnectFlush({
				prevState: "ready",
				state: "busy",
				hasSessionId: true,
				awaitingSessionId: true,
			}),
		).toEqual({
			dispatchAcquisitionComplete: false,
			dispatchAcquisitionFailed: false,
			awaitingSessionId: false,
		});
	});
});

describe("I103 — connect-flush delivery", () => {
	it("historical gap: the OLD connect-flush never flushes the lag sequence (pre-existing)", () => {
		expect(oldDelivers(LAG)).toBe(false);
	});

	it("REGRESSION GUARD: the FIXED connect-flush delivers the lag sequence exactly once", () => {
		expect(fixedDelivers(LAG)).toBe(true);
	});

	it("fresh-tab no-lag still delivers exactly once", () => {
		expect(fixedDelivers(NO_LAG)).toBe(true);
	});

	it("disjoint: a turn end (busy→ready) does NOT connect-flush", () => {
		// initialPrev "ready" — the acquisition edge already happened earlier.
		expect(fixedDelivers(TURN_END, "ready")).toBe(false);
	});
});
