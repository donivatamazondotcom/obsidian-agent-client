/**
 * SessionDispatchPort (D8/D13) — the minimal detached-send seam for
 * agent-emitted interactive prompts (and, later, anything else that needs a
 * composer-independent send).
 *
 * WHY NOT THE QUICK-PROMPT BRIDGE
 * `QuickPromptComposerBridge.fireOrQueue` clears the composer on send and
 * SEEDS it on queue (the queue's Edit flow treats the composer as source of
 * truth) — reusing it for A2UI actions would clobber unsent drafts or dump
 * action JSON into the composer. This port has no composer dependencies at
 * the type level, so that hazard is unrepresentable. The bridge's send leg
 * can later be refactored ONTO this port without behavior change (optional
 * hygiene per the spec's § Quick Prompts bridge).
 *
 * ENABLEMENT (D7, as revised by A2UI-I08)
 * The decision is NOT made here — it is read from `deriveA2uiTabDispatch`,
 * the same pure resolver the renderer's `deriveSurfaceActionAffordance`
 * composes. That shared read is what makes "enabled button, refusing port"
 * unrepresentable; previously this port required `lazyState === "ready"`
 * while the renderer ignored liveness entirely, so a disconnected tab showed
 * live controls that errored on click.
 *
 * Three outcomes, by mode:
 *   - `sendNow`        → dispatch immediately through the tab's send path.
 *   - `acquireAndSend` → no live session: hold the action for acquisition.
 *                        Delivery happens on the connect-flush edge, exactly
 *                        as a composer send on an idle tab. The composer is
 *                        still never read or written (the held message is
 *                        flagged detached, so the flush skips its clear).
 *   - `refuse`         → notify with a plain-language reason, dispatch nothing.
 *
 * Pure over injected thunks — no React, no Obsidian imports.
 */
import type { TabSessionState } from "../types/tab";
import {
	deriveA2uiTabDispatch,
	type A2uiTabDispatchMode,
	type A2uiTabRefuseReason,
} from "../resolvers/a2ui-dispatch";
import { t, type TranslationKey } from "../i18n";

/** Plain-language refusal copy (user-facing copy rule: no jargon). */
const REFUSAL_COPY_KEYS: Record<A2uiTabRefuseReason, TranslationKey> = {
	sending: "notices.a2uiBusy",
	permission: "notices.a2uiPermission",
	queued: "notices.a2uiQueued",
	restoring: "notices.a2uiRestoring",
};

/**
 * What happened to a detached send. Tagged so the caller can drive the
 * surface's pending lifecycle without inferring it from a boolean:
 *   - `sent`     → dispatched; the answer will arrive in the transcript.
 *   - `held`     → accepted, waiting for the session to reconnect.
 *   - `refused`  → not dispatchable right now; the user was notified.
 *   - `failed`   → the underlying send threw or rejected.
 */
export type A2uiDispatchOutcome = "sent" | "held" | "refused" | "failed";

export interface SessionDispatchPortDeps {
	/** Per-tab lazy session state (thunk — always fresh). */
	lazyState: () => TabSessionState;
	/** A turn is currently streaming. */
	isSending: () => boolean;
	/** The queue-of-one slot is occupied. */
	isQueued: () => boolean;
	/** Session history is being restored/loaded. */
	isRestoringSession: () => boolean;
	/** Dispatch text through the tab's normal send path (composer-neutral). */
	sendMessage: (text: string) => Promise<void>;
	/**
	 * Hold `text` as the tab's one pending message and trigger session
	 * acquisition; the connect-flush delivers it once the session is ready.
	 * `surfaceId` tags the held message so (a) the flush skips the composer
	 * clear and (b) the originating surface can render as pending while the
	 * agent reconnects.
	 */
	holdForAcquisition: (text: string, surfaceId: string) => void;
	/** Show a transient notice. */
	notify: (message: string) => void;
}

export interface SessionDispatchPort {
	/** What a detached send would do right now. */
	mode(): A2uiTabDispatchMode;
	/** Would a detached send do anything at all? (dispatch or hold) */
	canSendNow(): boolean;
	/**
	 * Send `text` to the source session without reading or writing composer
	 * state, tagging the action with its `surfaceId`. Never throws.
	 */
	sendDetached(text: string, surfaceId: string): Promise<A2uiDispatchOutcome>;
	/** Surface a transient message to the user. */
	notify(message: string): void;
}

export function createSessionDispatchPort(
	deps: SessionDispatchPortDeps,
): SessionDispatchPort {
	const mode = (): A2uiTabDispatchMode =>
		deriveA2uiTabDispatch({
			sessionState: deps.lazyState(),
			isSending: deps.isSending(),
			isQueued: deps.isQueued(),
			isRestoringSession: deps.isRestoringSession(),
		});

	return {
		mode,
		canSendNow: () => mode().kind !== "refuse",
		sendDetached: async (
			text: string,
			surfaceId: string,
		): Promise<A2uiDispatchOutcome> => {
			const decision = mode();
			if (decision.kind === "refuse") {
				deps.notify(t(REFUSAL_COPY_KEYS[decision.reason]));
				return "refused";
			}
			if (decision.kind === "acquireAndSend") {
				// No live session. Hold + acquire; the connect-flush delivers.
				try {
					deps.holdForAcquisition(text, surfaceId);
					return "held";
				} catch {
					return "failed";
				}
			}
			try {
				await deps.sendMessage(text);
				return "sent";
			} catch {
				return "failed";
			}
		},
		notify: (message: string) => deps.notify(message),
	};
}
