/**
 * T04/T05 seeds — the two pure read-time decisions for surfaces:
 *
 * 1. `deriveSurfaceAnswers` — answered state derives from the transcript
 *    alone (action user messages), so restore/replay reconstructs it with no
 *    separate state store (spec § Surface and transcript lifecycle).
 * 2. `deriveSurfaceActionAffordance` — D7: controls enabled only when the
 *    tab is idle with an empty queue slot; never queue; disabled-with-reason
 *    otherwise. One resolver, both render and dispatch read it.
 */
import { describe, expect, it } from "vitest";
import {
	deriveSurfaceActionAffordance,
	deriveSurfaceAnswers,
} from "../surface-state";

const ACTION_MESSAGE = (surfaceId: string, componentId: string): string =>
	`Selected: X\n\n\`\`\`a2ui\n{"version":"v1.0","action":{"name":"choose_scope","surfaceId":"${surfaceId}","sourceComponentId":"${componentId}","timestamp":"2026-07-16T09:00:00Z","context":{"scope":"x"}}}\n\`\`\``;

describe("deriveSurfaceAnswers", () => {
	it("returns no answers for a transcript without action messages", () => {
		const answers = deriveSurfaceAnswers([
			{ role: "user", text: "hello" },
			{ role: "assistant", text: "hi ```a2ui\nnot an action\n```" },
		]);
		expect(answers.size).toBe(0);
	});

	it("maps a surface to the component chosen in an action user message (T05)", () => {
		const answers = deriveSurfaceAnswers([
			{ role: "user", text: ACTION_MESSAGE("migration-scope-7f3a", "complete") },
		]);
		expect(answers.get("migration-scope-7f3a")).toBe("complete");
	});

	it("ignores action-shaped fences in assistant messages (T08)", () => {
		const answers = deriveSurfaceAnswers([
			{ role: "assistant", text: ACTION_MESSAGE("s-1a2b", "b") },
		]);
		expect(answers.size).toBe(0);
	});

	it("first action wins for a surface (single-shot in v0)", () => {
		const answers = deriveSurfaceAnswers([
			{ role: "user", text: ACTION_MESSAGE("s-1a2b", "first") },
			{ role: "user", text: ACTION_MESSAGE("s-1a2b", "second") },
		]);
		expect(answers.get("s-1a2b")).toBe("first");
	});

	it("tracks multiple surfaces independently", () => {
		const answers = deriveSurfaceAnswers([
			{ role: "user", text: ACTION_MESSAGE("s-1", "a") },
			{ role: "user", text: ACTION_MESSAGE("s-2", "b") },
		]);
		expect(answers.get("s-1")).toBe("a");
		expect(answers.get("s-2")).toBe("b");
	});

	it("tolerates malformed action fences without throwing", () => {
		const answers = deriveSurfaceAnswers([
			{ role: "user", text: "Selected: X\n\n```a2ui\n{broken\n```" },
			{
				role: "user",
				text: 'Selected: Y\n\n```a2ui\n{"version":"v1.0","action":{"name":"n"}}\n```',
			},
		]);
		expect(answers.size).toBe(0);
	});
});

describe("deriveSurfaceActionAffordance (D7)", () => {
	const IDLE = {
		sessionState: "ready" as const,
		isSending: false,
		isQueued: false,
		isRestoringSession: false,
		surfaceStatus: "unanswered" as const,
		isStreamingTurn: false,
		isSuperseded: false,
	};

	it("enables on an idle tab with an unanswered surface", () => {
		expect(deriveSurfaceActionAffordance(IDLE)).toEqual({
			enabled: true,
			reason: "ready",
			mode: "sendNow",
		});
	});

	it("disables while the surface's own turn is still streaming (T01)", () => {
		const affordance = deriveSurfaceActionAffordance({
			...IDLE,
			isStreamingTurn: true,
		});
		expect(affordance.enabled).toBe(false);
		expect(affordance.reason).toBe("streaming");
	});

	it("disables while any turn is in flight (T04a)", () => {
		expect(
			deriveSurfaceActionAffordance({ ...IDLE, isSending: true }),
		).toEqual({ enabled: false, reason: "sending", mode: "refuse" });
	});

	it("disables while a message is queued — actions never queue (T04b)", () => {
		expect(deriveSurfaceActionAffordance({ ...IDLE, isQueued: true })).toEqual(
			{ enabled: false, reason: "queued", mode: "refuse" },
		);
	});

	it("disables while restoring session history", () => {
		expect(
			deriveSurfaceActionAffordance({ ...IDLE, isRestoringSession: true }),
		).toEqual({ enabled: false, reason: "restoring", mode: "refuse" });
	});

	it("disables an answered surface (single-shot; T04 second activation impossible)", () => {
		expect(
			deriveSurfaceActionAffordance({ ...IDLE, surfaceStatus: "answered" }),
		).toEqual({ enabled: false, reason: "answered", mode: "refuse" });
	});

	it("disables a pending surface (dispatch in flight)", () => {
		expect(
			deriveSurfaceActionAffordance({ ...IDLE, surfaceStatus: "pending" }),
		).toEqual({ enabled: false, reason: "pending", mode: "refuse" });
	});

	it("disables an earlier unanswered surface once a newer one exists (superseded)", () => {
		expect(
			deriveSurfaceActionAffordance({ ...IDLE, isSuperseded: true }),
		).toEqual({ enabled: false, reason: "superseded", mode: "refuse" });
	});

	it("answered outranks superseded (an answered old surface keeps its answered look)", () => {
		expect(
			deriveSurfaceActionAffordance({
				...IDLE,
				isSuperseded: true,
				surfaceStatus: "answered",
			}).reason,
		).toBe("answered");
	});

	it("pending/answered outrank turn state (status is the closer reason)", () => {
		expect(
			deriveSurfaceActionAffordance({
				...IDLE,
				isSending: true,
				surfaceStatus: "answered",
			}).reason,
		).toBe("answered");
	});
});
