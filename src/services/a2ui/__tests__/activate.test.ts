/**
 * A2UI-I01 reproduce-first — refocus timing.
 *
 * The composer refocus after a button activation must fire at DISPATCH, not
 * behind the send promise: ACP `session/prompt` resolves only when the whole
 * streamed turn ends (the I173 class), so an awaited refocus lands minutes
 * late. Round-1 fix awaited `sendDetached` and failed the human re-check.
 *
 * The test models the failure precisely: a send whose promise NEVER resolves
 * (a turn that streams forever). Refocus must still have fired synchronously.
 */
import { describe, expect, it, vi } from "vitest";
import { activateA2uiButton } from "../activate";
import type {
	A2uiDispatchOutcome,
	SessionDispatchPort,
} from "../../session-dispatch-port";
import type { A2uiButton } from "../action";

const BUTTON: A2uiButton = {
	kind: "button",
	id: "minimal",
	child: "minimal-label",
	label: "Minimal fix",
	event: { name: "choose_scope", context: { scope: "minimal" } },
};

function makePort(overrides: Partial<SessionDispatchPort> = {}): {
	port: SessionDispatchPort;
	sent: string[];
	surfaceIds: string[];
} {
	const sent: string[] = [];
	const surfaceIds: string[] = [];
	return {
		sent,
		surfaceIds,
		port: {
			mode: () => ({ kind: "sendNow" }),
			canSendNow: () => true,
			sendDetached: (text: string, surfaceId: string) => {
				sent.push(text);
				surfaceIds.push(surfaceId);
				// Never resolves — the turn streams forever (the precise
				// failure shape a refocus-behind-await would hit).
				return new Promise<A2uiDispatchOutcome>(() => {});
			},
			notify: () => {},
			...overrides,
		},
	};
}

describe("activateA2uiButton — refocus at dispatch (A2UI-I01)", () => {
	it("refocuses the composer synchronously, before the send promise settles", () => {
		const { port, sent } = makePort();
		const refocus = vi.fn();
		void activateA2uiButton({
			port,
			surfaceId: "migration-scope-7f3a",
			button: BUTTON,
			now: () => "2026-07-16T13:50:00.000Z",
			refocusComposer: refocus,
		});
		// The send never resolves; the refocus must already have fired.
		expect(refocus).toHaveBeenCalledTimes(1);
		expect(sent).toHaveLength(1);
		expect(sent[0].startsWith("Selected: Minimal fix")).toBe(true);
	});

	it("does not refocus when the port refuses the send (cannot send now)", () => {
		const { port } = makePort({
			mode: () => ({ kind: "refuse", reason: "sending" }),
			canSendNow: () => false,
			sendDetached: () => Promise.resolve("refused"),
		});
		const refocus = vi.fn();
		void activateA2uiButton({
			port,
			surfaceId: "s-1a2b",
			button: BUTTON,
			now: () => "2026-07-16T13:50:00.000Z",
			refocusComposer: refocus,
		});
		expect(refocus).not.toHaveBeenCalled();
	});

	it("returns the port's outcome for the pending/answered lifecycle (T11)", async () => {
		const { port } = makePort({
			sendDetached: () => Promise.resolve("failed"),
		});
		await expect(
			activateA2uiButton({
				port,
				surfaceId: "s-1a2b",
				button: BUTTON,
				now: () => "2026-07-16T13:50:00.000Z",
				refocusComposer: () => {},
			}),
		).resolves.toBe("failed");
	});

	// A2UI-I08: the surfaceId must reach the port so a HELD action can be
	// attributed back to the surface that is waiting on it.
	it("forwards the surfaceId to the port", () => {
		const { port, surfaceIds } = makePort();
		void activateA2uiButton({
			port,
			surfaceId: "migration-scope-7f3a",
			button: BUTTON,
			now: () => "2026-07-16T13:50:00.000Z",
			refocusComposer: () => {},
		});
		expect(surfaceIds).toEqual(["migration-scope-7f3a"]);
	});

	it("refocuses when the action is HELD for reconnect (the click did take effect)", () => {
		const { port } = makePort({
			mode: () => ({ kind: "acquireAndSend" }),
			sendDetached: () => Promise.resolve("held"),
		});
		const refocus = vi.fn();
		void activateA2uiButton({
			port,
			surfaceId: "s-1a2b",
			button: BUTTON,
			now: () => "2026-07-16T13:50:00.000Z",
			refocusComposer: refocus,
		});
		expect(refocus).toHaveBeenCalledTimes(1);
	});
});
