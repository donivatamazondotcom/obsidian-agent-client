/**
 * Button-activation orchestration (A2UI-I01).
 *
 * WHY THIS EXISTS: the refocus-after-activation must fire at DISPATCH time.
 * ACP `session/prompt` resolves only when the whole streamed turn ends (the
 * I173 class — see `sendAndReturnFocus`), so any refocus awaited behind
 * `sendDetached`'s promise lands at turn end, minutes late. The round-1 fix
 * made exactly that mistake and failed the human re-check.
 *
 * Sequence: gate on `canSendNow` (no refocus on a refused activation — the
 * click did nothing), start the detached send, refocus IMMEDIATELY, and
 * return the send promise for the pending/answered lifecycle (T11: a false
 * resolution re-enables the surface).
 *
 * Pure over injected seams (port, clock, refocus effect) — unit-testable
 * against a never-resolving send, which is the precise failure shape.
 */
import type {
	A2uiDispatchOutcome,
	SessionDispatchPort,
} from "../session-dispatch-port";
import { buildA2uiActionUserMessage, type A2uiButton } from "./action";

export interface ActivateA2uiButtonInput {
	port: SessionDispatchPort;
	surfaceId: string;
	button: A2uiButton;
	/** Clock (ISO 8601), injected for purity. */
	now: () => string;
	/** Return focus to the composer — fired at dispatch, never awaited. */
	refocusComposer: () => void;
}

export function activateA2uiButton(
	input: ActivateA2uiButtonInput,
): Promise<A2uiDispatchOutcome> {
	const message = buildA2uiActionUserMessage({
		surfaceId: input.surfaceId,
		button: input.button,
		timestamp: input.now(),
	});
	// Same-tick read: the port's own internal gate sees the same state, so
	// this check and the dispatch below cannot disagree.
	const willDispatch = input.port.canSendNow();
	const result = input.port.sendDetached(message, input.surfaceId);
	// Dispatch-time refocus: the send promise resolves at TURN END, so the
	// caret must come back now, while the reply streams. A refused activation
	// (port notifies + resolves "refused") doesn't steal focus. An action held
	// for reconnect DID take effect, so it refocuses like a live dispatch.
	if (willDispatch) input.refocusComposer();
	return result;
}
