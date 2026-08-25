/**
 * D8/D13 — SessionDispatchPort: the minimal detached-send seam A2UI actions
 * dispatch through. By construction it has NO composer dependencies (no
 * getComposerText/setComposerText/insertAtCursor thunks exist on its deps
 * type), so a detached send can never clobber an unsent draft — the verified
 * fireOrQueue hazard the spec's § Quick Prompts bridge documents.
 *
 * Enablement routes through `deriveA2uiTabDispatch` — the SAME pure resolver
 * the renderer composes — so an enabled control always has a dispatchable
 * port (A2UI-I08). Actions still never queue behind a live turn, but a tab
 * with no live session now RECONNECTS and holds the action for delivery
 * rather than refusing it.
 */
import { describe, expect, it, vi } from "vitest";
import { createSessionDispatchPort } from "../session-dispatch-port";
import type { SessionDispatchPortDeps } from "../session-dispatch-port";
import type { TabSessionState } from "../../types/tab";

function makeDeps(
	overrides: Partial<{
		lazyState: TabSessionState;
		isSending: boolean;
		isQueued: boolean;
		isRestoringSession: boolean;
		sendMessage: (text: string) => Promise<void>;
	}> = {},
): SessionDispatchPortDeps & {
	sent: string[];
	held: string[];
	notices: string[];
} {
	const sent: string[] = [];
	const held: string[] = [];
	const notices: string[] = [];
	return {
		sent,
		held,
		notices,
		lazyState: () => overrides.lazyState ?? "ready",
		isSending: () => overrides.isSending ?? false,
		isQueued: () => overrides.isQueued ?? false,
		isRestoringSession: () => overrides.isRestoringSession ?? false,
		sendMessage:
			overrides.sendMessage ??
			(async (text: string) => {
				sent.push(text);
			}),
		holdForAcquisition: (text: string) => {
			held.push(text);
		},
		notify: (message: string) => {
			notices.push(message);
		},
	};
}

describe("createSessionDispatchPort — canSendNow", () => {
	it("is true on a live, idle tab with an empty queue slot", () => {
		expect(createSessionDispatchPort(makeDeps()).canSendNow()).toBe(true);
	});

	it.each<TabSessionState>(["idle", "connecting", "error"])(
		"is TRUE when the session is not live (%s) — the click reconnects (A2UI-I08)",
		(lazyState) => {
			const port = createSessionDispatchPort(makeDeps({ lazyState }));
			expect(port.canSendNow()).toBe(true);
			expect(port.mode().kind).toBe("acquireAndSend");
		},
	);

	it.each<TabSessionState>(["busy", "permission"])(
		"is false while the session is live but not idle (%s)",
		(lazyState) => {
			expect(
				createSessionDispatchPort(makeDeps({ lazyState })).canSendNow(),
			).toBe(false);
		},
	);

	it("is false while a turn is streaming", () => {
		expect(
			createSessionDispatchPort(makeDeps({ isSending: true })).canSendNow(),
		).toBe(false);
	});

	it("is false while the queue slot is occupied — actions never queue", () => {
		expect(
			createSessionDispatchPort(makeDeps({ isQueued: true })).canSendNow(),
		).toBe(false);
	});

	it("is false while session history is restoring", () => {
		expect(
			createSessionDispatchPort(
				makeDeps({ isRestoringSession: true }),
			).canSendNow(),
		).toBe(false);
	});

	it("reads live state through thunks (never goes stale)", () => {
		let sending = true;
		const deps = makeDeps();
		deps.isSending = () => sending;
		const port = createSessionDispatchPort(deps);
		expect(port.canSendNow()).toBe(false);
		sending = false;
		expect(port.canSendNow()).toBe(true);
	});
});

describe("createSessionDispatchPort — sendDetached", () => {
	it("dispatches the text through the send path and resolves true", async () => {
		const deps = makeDeps();
		const port = createSessionDispatchPort(deps);
		await expect(port.sendDetached("Selected: X", "s1")).resolves.toBe("sent");
		expect(deps.sent).toEqual(["Selected: X"]);
		expect(deps.held).toEqual([]);
	});

	it("refuses when it cannot send now: no dispatch, notifies, resolves false", async () => {
		const deps = makeDeps({ isQueued: true });
		const port = createSessionDispatchPort(deps);
		await expect(port.sendDetached("Selected: X", "s1")).resolves.toBe(
			"refused",
		);
		expect(deps.sent).toEqual([]);
		expect(deps.notices.length).toBe(1);
	});

	it("resolves false when the underlying send rejects (T11 seed)", async () => {
		const deps = makeDeps({
			sendMessage: () => Promise.reject(new Error("session gone")),
		});
		const port = createSessionDispatchPort(deps);
		await expect(port.sendDetached("Selected: X", "s1")).resolves.toBe(
			"failed",
		);
	});

	it("never throws on a synchronously-throwing send", async () => {
		const deps = makeDeps({
			sendMessage: () => {
				throw new Error("boom");
			},
		});
		const port = createSessionDispatchPort(deps);
		await expect(port.sendDetached("x", "s1")).resolves.toBe("failed");
	});
});

describe("createSessionDispatchPort — notify passthrough", () => {
	it("forwards notifications", () => {
		const deps = makeDeps();
		createSessionDispatchPort(deps).notify("hello");
		expect(deps.notices).toEqual(["hello"]);
	});

	it("has no composer surface (compile-time contract)", () => {
		// The deps type has no composer thunks; this assertion documents the
		// D8 guarantee at runtime for reviewers reading test output.
		const port = createSessionDispatchPort(makeDeps());
		expect(Object.keys(port).sort()).toEqual([
			"canSendNow",
			"mode",
			"notify",
			"sendDetached",
		]);
	});
});

// Deliberate vi import usage guard (mock budget R4: no mocks needed at all —
// the port is pure over injected thunks).
void vi;
