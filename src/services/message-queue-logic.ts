/**
 * message-queue-logic — pure decision helpers for the queue-next-message
 * feature (#82). Extracted from ChatPanel / plugin so the load-bearing
 * decisions (queue vs send, flush vs hold, broadcast skip) are unit-testable
 * without mounting the React tree — same pattern as the I70 broadcast test.
 *
 * See [[Agent Console Queue Next Message]].
 */

import type { AttachedFile, QueuedMessage } from "../types/chat";
import type { TabSessionState } from "../types/tab";
import { t } from "../i18n";

/**
 * Whether a send action should QUEUE rather than dispatch a turn.
 *
 * Queue is the default while the agent is streaming (a turn is in flight);
 * when idle there is nothing to queue behind, so the send dispatches normally.
 * `isSending` is true only on a live, streaming session, so it alone is the
 * trigger.
 */
export function shouldQueueOnSend(params: { isSending: boolean }): boolean {
	return params.isSending;
}

/** What pressing the send key (Enter) in the composer should do. */
export type ComposerEnterAction = "send" | "queue" | "steer" | "none";

/** The configured send-key mode (Settings → "Send message with"). */
export type SendMessageShortcut = "enter" | "cmd-enter";

/**
 * Decide the Enter-key action in the composer (#82 queue + #81 steer).
 *
 * - **steer** — a live turn is streaming, the steer gesture was pressed, and
 *   there is content to redirect with → cancel-then-redirect ([[Agent Console
 *   Mid-Stream Steering]]). Takes precedence over queue while streaming.
 * - **send** — not streaming and the send button is enabled → normal dispatch.
 * - **queue** — streaming (plain send key) or the session isn't ready yet,
 *   nothing queued, and there is content → queue the next message.
 * - **none** — a message is already queued (queue-of-one), empty composer, or
 *   the send button is disabled (connecting/restoring).
 *
 * `steerRequested` is optional (defaults to "not a steer") so existing callers
 * that only queue keep their behavior unchanged.
 */
export function decideComposerEnterAction(params: {
	isStreaming: boolean;
	isSessionReady: boolean;
	isButtonDisabled: boolean;
	isQueued: boolean;
	hasContent: boolean;
	/** The steer gesture (mode-aware, see {@link isSteerGesture}) was pressed. */
	steerRequested?: boolean;
	/**
	 * The composer is a LAUNCHER (zero-tab landing): the send target is a
	 * new-tab launch, not this session (deriveComposerAffordances
	 * sendMode:"launch"). When true, `!isSessionReady` must NOT route to queue —
	 * there is no session to connect/flush; Enter dispatches (→ launch).
	 * Defaults to false (in-tab composer).
	 */
	launches?: boolean;
}): ComposerEnterAction {
	if (params.isQueued || !params.hasContent) return "none";
	// Steer beats queue while a live turn is in flight: the user deliberately
	// asked to interrupt-and-redirect. Only meaningful while streaming — a
	// steer gesture on an idle/ready composer falls through to a normal send.
	if (params.isStreaming && params.steerRequested) return "steer";
	// Queue when a turn is streaming OR the session isn't ready yet
	// (connecting/idle acquisition) — both are "the message can't dispatch
	// right now, hold it as the one pending message" (#82 Decision 9). The
	// composer locks; the message flushes on turn-end or on connect.
	// EXCEPT a launcher composer (zero-tab landing): "not ready" there means
	// "no session to connect/flush" — Enter must dispatch (→ launch), not queue
	// into a dead handler. sendMode:"launch" → launches:true.
	if (params.isStreaming || (!params.isSessionReady && !params.launches))
		return "queue";
	if (params.isButtonDisabled) return "none";
	return "send";
}

/**
 * Whether a key event's modifiers mean **steer** (#81), given the configured
 * send-key mode. Steer must never collide with the user's send key:
 *
 * - **enter mode** (plain Enter sends/queues): the Mod key is free, so
 *   **Mod+Enter** is the steer gesture.
 * - **cmd-enter mode** (Mod+Enter sends/queues): Mod+Enter is taken, so steer
 *   is **Mod+Shift+Enter**.
 *
 * Both combos always satisfy InputArea's existing `shouldSend` gate (they carry
 * the Mod key), so the resolver sees them; the mode branch here is the only
 * place send-mode is consulted for steer. Pure — no platform/DOM access.
 */
export function isSteerGesture(params: {
	hasCmdCtrl: boolean;
	shiftKey: boolean;
	sendShortcut: SendMessageShortcut;
}): boolean {
	return params.sendShortcut === "enter"
		? params.hasCmdCtrl && !params.shiftKey
		: params.hasCmdCtrl && params.shiftKey;
}

/**
 * Queued-banner text. The pending message is waiting on different things in
 * the two states (#82 Decision 9):
 * - streaming (session ready, turn in flight) → sends when the turn ends.
 * - pre-ready (connecting/idle acquisition) → sends when the session connects.
 */
export function buildQueuedBanner(params: {
	agentLabel: string;
	isSessionReady: boolean;
	/**
	 * The held message is a DETACHED action from an interactive surface, not
	 * composer text (A2UI-I08). The composer text is untouched, so the banner
	 * must not claim it is queued.
	 */
	isAction?: boolean;
}): string {
	if (params.isAction) return t("chat.composer.queuedBannerAction");
	return params.isSessionReady
		? t("chat.composer.queuedBannerReady", { agent: params.agentLabel })
		: t("chat.composer.queuedBannerWaiting");
}

/** Lazy-session states relevant to the connect-flush transition. */
export type LazyFlushState = string;

/**
 * Whether to flush the queued message because session acquisition just
 * completed (#82 Decision 9).
 *
 * Keyed on the **(connecting|idle)→ready** transition, NOT "ready && !sending":
 * a turn ending is `busy→ready`, which the gated turn-end flush owns. Gating on
 * the acquisition edge keeps the two flush paths disjoint, so the connect-flush
 * can't double-fire with — or bypass the hold-on-error/cancel gate of — the
 * turn-end flush. Acquisition failure (`connecting→error`) never reaches
 * `ready`, so the message holds.
 */
export function shouldFlushOnReady(params: {
	prevState: string;
	state: string;
	hasSessionId: boolean;
	isQueued: boolean;
}): boolean {
	const acquisitionJustCompleted =
		(params.prevState === "connecting" || params.prevState === "idle") &&
		params.state === "ready";
	return acquisitionJustCompleted && params.hasSessionId && params.isQueued;
}

/**
 * Composer placeholder text (#82 affordance — option A, discovery-only).
 *
 * While the agent is streaming (and nothing is queued yet), the empty-composer
 * placeholder teaches the queue keybinding — the same way the idle placeholder
 * teaches "@ to mention / for commands." It's discovery-only: it shows when the
 * composer is empty and vanishes once the user types (placeholders only render
 * when empty), which is acceptable because the binding is learned once.
 *
 * Queue-only wording for now; the steering keybinding ([[Agent Console
 * Mid-Stream Steering]] #81) gets added here when that ships.
 */
export function buildComposerPlaceholder(params: {
	agentLabel: string;
	hasCommands: boolean;
	hasQuickPrompts?: boolean;
	isStreaming: boolean;
	isQueued: boolean;
	/** Platform-labeled key that queues while streaming (e.g. "Enter", "⌘Enter"). */
	queueKeyLabel?: string;
	/** Platform-labeled key that steers while streaming (e.g. "⌘Enter", "⌘⇧Enter"). */
	steerKeyLabel?: string;
}): string {
	if (params.isStreaming && !params.isQueued) {
		// #81: once both keybinding labels are supplied, teach queue AND steer.
		// Falls back to the queue-only wording when labels aren't provided, so
		// callers that predate steering keep their behavior.
		if (params.queueKeyLabel && params.steerKeyLabel) {
			return t("chat.composer.placeholderQueueSteer", {
				queueKey: params.queueKeyLabel,
				steerKey: params.steerKeyLabel,
			});
		}
		return t("chat.composer.placeholderStreaming", {
			agent: params.agentLabel,
		});
	}
	return t("chat.composer.placeholder", {
		agent: params.agentLabel,
		commands: params.hasCommands
			? t("chat.composer.placeholderCommands")
			: "",
	});
}

export interface FlushDecisionParams {
	/** The turn ended this tick: isSending went true -> false. */
	turnEnded: boolean;
	/** A message is currently queued. */
	isQueued: boolean;
	/** The turn that just ended errored (errorInfo was set). */
	hadError: boolean;
	/** The turn that just ended was cancelled by the user (stop generation). */
	wasCancelled: boolean;
}

/**
 * Whether to auto-send the queued message now.
 *
 * Decision 5 (hold-on-error/cancel): a queued message auto-fires ONLY when the
 * turn it was waiting on completed normally. An errored or cancelled turn
 * holds the queued message (it does not fire into the dead turn); it degrades
 * to a preserved draft if the turn is later destroyed (close/reopen, restart).
 *
 * Contrast {@link naiveShouldFlush} (test-only) which fires on any turn end —
 * the bug this guard prevents.
 */
export function shouldFlushQueue(params: FlushDecisionParams): boolean {
	return (
		params.turnEnded &&
		params.isQueued &&
		!params.hadError &&
		!params.wasCancelled
	);
}

/**
 * Perform the queue flush: consume the head, clear the composer, then dispatch
 * through the normal send path — in that order.
 *
 * The ordering is load-bearing (T3/T4): clearing the composer BEFORE dispatch
 * means draft-preservation observes the emptied composer and persists "" — a
 * side-channel send that skipped the clear would strand a stale draft. Routing
 * `dispatch` through the normal send path (handleSendWithLazyAcquisition) is
 * what makes the cleared value persist on the next save event.
 *
 * @returns true if a message was flushed, false if the queue was empty.
 */
export function executeFlush(deps: {
	consume: () => QueuedMessage | null;
	clearComposer: () => void;
	dispatch: (content: string, attachments?: AttachedFile[]) => void;
}): boolean {
	const payload = deps.consume();
	if (!payload) return false;
	deps.clearComposer();
	deps.dispatch(payload.content, payload.attachments);
	return true;
}

/**
 * Whether the composer's send action (button click or Enter) must be blocked
 * because a message is queued (#82, smoke-test issue 3).
 *
 * While streaming, the primary button is **Stop** (isSending true) — that must
 * stay live so the user can cancel (T7), so this returns false then. But once
 * a queued message is being *held* (queued + no live turn, e.g. after an
 * errored/cancelled turn), the composer is locked and the Send button would
 * otherwise fire the locked text, bypassing the queue. Block it — the user
 * acts via Edit/Delete instead.
 */
export function isQueuedSendBlocked(params: {
	isQueued: boolean;
	isSending: boolean;
}): boolean {
	return params.isQueued && !params.isSending;
}

/** Minimal shape of a broadcast target for skip-guard selection. */
export interface BroadcastTarget {
	readonly tabId: string;
	canSend(): boolean;
	/** True when this tab already holds a pending queued message (#82). */
	hasPendingQueue(): boolean;
}

/**
 * Tabs that broadcast-send should fan out to.
 *
 * Skips tabs already holding a pending queued message (queue-of-one — can't
 * add a second) in addition to the existing canSend() gate. Skipped tabs are
 * reported in the summary Notice.
 */
export function selectBroadcastSendTargets<T extends BroadcastTarget>(
	handles: T[],
): { targets: T[]; skippedQueued: T[] } {
	const skippedQueued = handles.filter(
		(h) => h.canSend() && h.hasPendingQueue(),
	);
	const targets = handles.filter((h) => h.canSend() && !h.hasPendingQueue());
	return { targets, skippedQueued };
}

/**
 * Tabs that broadcast-prompt should write into (excluding the source tab).
 *
 * Skips tabs holding a pending queued message — overwriting their composer
 * (setInputState) would clobber a committed message (data loss). This narrowly
 * overrides F11 decision #4 (unconditional draft overwrite) for *queued*
 * (committed) messages only, not loose drafts.
 */
export function selectBroadcastPromptTargets<
	T extends Pick<BroadcastTarget, "tabId" | "hasPendingQueue">,
>(handles: T[], sourceTabId: string): { targets: T[]; skippedQueued: T[] } {
	const others = handles.filter((h) => h.tabId !== sourceTabId);
	const skippedQueued = others.filter((h) => h.hasPendingQueue());
	const targets = others.filter((h) => !h.hasPendingQueue());
	return { targets, skippedQueued };
}


/**
 * Connect-flush trigger decision (I103 fix).
 *
 * The connect-flush must dispatch `acquisitionComplete` to the queue reducer
 * when session acquisition completes — but `agent.session.sessionId` is
 * committed by a setState that LAGS the `lazySession.state -> "ready"`
 * transition on the restored/loadSession path (extra await hops in
 * loadExistingSessionFlow). Keying purely on the (connecting|idle)->ready EDGE
 * meant the edge fired with `hasSessionId=false` (reducer holds) and, when the
 * sessionId committed a render later, there was no fresh edge — so the queued
 * message stuck forever (I103: re-sent draft never flushes).
 *
 * This decision arms an `awaitingSessionId` flag when the acquisition edge
 * fires before the sessionId is committed, and dispatches once the sessionId
 * lands while still `ready`. Crucially it stays DISJOINT from the turn-end
 * flush (busy->ready): a turn ending is NOT an acquisition edge and never arms
 * the flag (leaving `ready` clears it), so this never double-fires with the
 * gated turn-end flush.
 *
 * Pure + stateful-by-value: the caller owns `prevState` and `awaitingSessionId`
 * as refs and feeds the returned `awaitingSessionId` back in next render.
 */
export interface ConnectFlushInput {
	/** lazySession.state from the previous render. */
	prevState: string;
	/** lazySession.state this render. */
	state: string;
	/** Whether agent.session.sessionId is committed this render. */
	hasSessionId: boolean;
	/** The awaiting-sessionId flag carried from the previous render. */
	awaitingSessionId: boolean;
}

export interface ConnectFlushDecision {
	/** Dispatch `acquisitionComplete` to the queue reducer now. */
	dispatchAcquisitionComplete: boolean;
	/**
	 * Dispatch `acquisitionFailed` now — the (connecting|idle)->error edge.
	 *
	 * A2UI-I08: without this the reducer's `acquisitionFailed` branch was dead
	 * code (declared, handled, never dispatched). Harmless while only composer
	 * text could be held — a failed acquisition holds the message and the user
	 * still has their text plus Edit/Delete. But a held detached ACTION has no
	 * composer text to retry from, so nothing released the slot: the surface
	 * stayed pending and the composer's send stayed blocked, with the banner's
	 * escape hatch suppressed. Found by driving a failed reconnect live.
	 *
	 * Scoped to the acquisition edge on purpose: `busy->error` is a turn that
	 * errored, and dispatching there would drop a message queued behind a live
	 * turn (the hold-on-error contract, Decision 5).
	 */
	dispatchAcquisitionFailed: boolean;
	/** Next value of the caller's awaiting-sessionId ref. */
	awaitingSessionId: boolean;
}

export function decideConnectFlush(
	input: ConnectFlushInput,
): ConnectFlushDecision {
	const { prevState, state, hasSessionId, awaitingSessionId } = input;

	// Not ready → nothing to flush; clear any pending await (e.g. connecting,
	// busy, error, or back to idle). This is what keeps us disjoint from the
	// turn-end flush: leaving `ready` always resets the flag.
	if (state !== "ready") {
		// Acquisition itself failed (never reached `ready`). Report it so the
		// reducer can release a held detached action; a held composer message
		// still holds, per Decision 5.
		const acquisitionFailedEdge =
			state === "error" && (prevState === "connecting" || prevState === "idle");
		return {
			dispatchAcquisitionComplete: false,
			dispatchAcquisitionFailed: acquisitionFailedEdge,
			awaitingSessionId: false,
		};
	}

	const acquisitionEdge =
		(prevState === "connecting" || prevState === "idle") && state === "ready";

	if (acquisitionEdge) {
		// Acquisition just completed. Flush now if the sessionId is committed;
		// otherwise wait for it (it commits a render later on the load path).
		return hasSessionId
			? {
					dispatchAcquisitionComplete: true,
					dispatchAcquisitionFailed: false,
					awaitingSessionId: false,
				}
			: {
					dispatchAcquisitionComplete: false,
					dispatchAcquisitionFailed: false,
					awaitingSessionId: true,
				};
	}

	// Already `ready`, no fresh acquisition edge. Deliver iff we were waiting on
	// the sessionId from a prior acquisition edge and it has now committed.
	if (awaitingSessionId && hasSessionId) {
		return {
			dispatchAcquisitionComplete: true,
			dispatchAcquisitionFailed: false,
			awaitingSessionId: false,
		};
	}

	return {
		dispatchAcquisitionComplete: false,
		dispatchAcquisitionFailed: false,
		awaitingSessionId,
	};
}

/**
 * Decide how a message typed while a session is mid-flight should be queued.
 *
 * When a LIVE session exists (`ready` / `busy` / `permission`) the message is
 * HELD and flushed on turn-end (`sendWhileStreaming`) — there is nothing to
 * acquire. Only when there is no live session (`idle` / `connecting` / `error`)
 * does it take the acquire path (`sendWhilePreReady`), which flushes on the
 * acquisition→ready edge.
 *
 * I109: the old inline check (`state === "ready"`) misrouted the common `busy`
 * (streaming) case to the acquire path. With a live session that acquire
 * usually no-ops, but a post-hard-reload `sessionId` flicker could let it fire
 * a spurious acquisition whose `acquisitionComplete` flushed the queued message
 * mid-stream instead of after the turn. Routing by live-session state removes
 * the acquire entirely during streaming.
 */
export function decideQueuedSendKind(
	state: TabSessionState,
): "sendWhileStreaming" | "sendWhilePreReady" {
	switch (state) {
		case "ready":
		case "busy":
		case "permission":
			return "sendWhileStreaming";
		case "idle":
		case "connecting":
		case "error":
			return "sendWhilePreReady";
	}
}