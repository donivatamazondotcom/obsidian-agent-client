/**
 * Pure read-time decisions for surface state (repo tenet: one decision, one
 * resolver — both the renderer and the dispatch path read these, never
 * re-derive them inline).
 *
 * 1. `deriveSurfaceAnswers` — answered state derives from the transcript
 *    alone: fences are canonical message text, action user messages are the
 *    submission record, so restore/replay reconstructs everything with no
 *    separate surface store (spec § Surface and transcript lifecycle, T05).
 * 2. `deriveSurfaceActionAffordance` — D7: v0 enablement = "can send now".
 *    Actions never queue; while anything is in flight the controls disable
 *    in place with a reason (same pattern as queued quick-prompt chips).
 */
import { extractA2uiFences } from "./fence-extractor";
import { validateA2uiFence } from "./validator";
import {
	deriveA2uiTabDispatch,
	type A2uiTabDispatchInput,
	type A2uiTabDispatchMode,
	type A2uiTabRefuseReason,
} from "../../resolvers/a2ui-dispatch";

/** The transcript slice this module needs — role + text only. */
export interface TranscriptMessageLike {
	role: string;
	text: string;
}

/**
 * Map of surfaceId → sourceComponentId chosen, derived from action user
 * messages in transcript order. First action wins (single-shot per surface
 * in v0). Total: malformed fences are skipped, never thrown on.
 */
export function deriveSurfaceAnswers(
	messages: readonly TranscriptMessageLike[],
): ReadonlyMap<string, string> {
	const answers = new Map<string, string>();
	for (const message of messages) {
		// Only user messages record submissions — an action-shaped fence in an
		// assistant message is quoted content, never a submission (T08 scope).
		if (message.role !== "user") continue;
		for (const fence of extractA2uiFences(message.text)) {
			if (!fence.closed) continue;
			const action = parseActionEnvelope(fence.body);
			if (action === null) continue;
			if (!answers.has(action.surfaceId)) {
				answers.set(action.surfaceId, action.sourceComponentId);
			}
		}
	}
	return answers;
}

interface ParsedAction {
	surfaceId: string;
	sourceComponentId: string;
}

/** Minimal, total parse of a client-to-server action envelope. */
function parseActionEnvelope(body: string): ParsedAction | null {
	const lines = body
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length !== 1) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(lines[0]);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const action = (parsed as Record<string, unknown>).action;
	if (typeof action !== "object" || action === null) return null;
	const { surfaceId, sourceComponentId } = action as Record<string, unknown>;
	if (typeof surfaceId !== "string" || typeof sourceComponentId !== "string") {
		return null;
	}
	return { surfaceId, sourceComponentId };
}

/** Per-surface submission status (runtime; reconstructed from transcript on restore). */
export type A2uiSurfaceStatus = "unanswered" | "pending" | "answered";

export type A2uiActionAffordanceReason =
	| "ready" // live session — dispatches immediately
	| "reconnect" // no live session — activation reconnects, then sends (A2UI-I08)
	| "answered" // single-shot: this surface already submitted
	| "pending" // dispatch in flight for this surface
	| "superseded" // a newer surface exists — enablement tracks the conversation frontier
	| "streaming" // the surface's own turn is still streaming (activate at turn end)
	// ...plus every tab-level refusal the shared resolver can return.
	| A2uiTabRefuseReason;

export interface A2uiActionAffordanceInput extends A2uiTabDispatchInput {
	surfaceStatus: A2uiSurfaceStatus;
	/** True while the assistant turn containing this surface is still streaming. */
	isStreamingTurn: boolean;
	/**
	 * True when a NEWER surface has been defined after this one. Earlier
	 * unanswered surfaces disable — the user answers the conversation's
	 * current fork, not a stale one (smoke finding, 2026-07-16).
	 */
	isSuperseded: boolean;
}

export interface A2uiActionAffordance {
	enabled: boolean;
	reason: A2uiActionAffordanceReason;
	/** What a click would do — mirrors the tab decision for enabled controls. */
	mode: A2uiTabDispatchMode["kind"];
}

/**
 * D7 (as revised by A2UI-I08) — the single enablement decision for surface
 * controls. Surface-scoped reasons come first (closest to the control), then
 * the shared tab-level decision above.
 */
export function deriveSurfaceActionAffordance(
	input: A2uiActionAffordanceInput,
): A2uiActionAffordance {
	// Surface-scoped refusals — independent of session liveness.
	let surfaceReason: A2uiActionAffordanceReason | null = null;
	if (input.surfaceStatus === "answered") {
		surfaceReason = "answered";
	} else if (input.surfaceStatus === "pending") {
		surfaceReason = "pending";
	} else if (input.isSuperseded) {
		surfaceReason = "superseded";
	} else if (input.isStreamingTurn) {
		surfaceReason = "streaming";
	}
	if (surfaceReason !== null) {
		return { enabled: false, reason: surfaceReason, mode: "refuse" };
	}

	const mode = deriveA2uiTabDispatch(input);
	switch (mode.kind) {
		case "sendNow":
			return { enabled: true, reason: "ready", mode: "sendNow" };
		case "acquireAndSend":
			return { enabled: true, reason: "reconnect", mode: "acquireAndSend" };
		case "refuse":
			return { enabled: false, reason: mode.reason, mode: "refuse" };
	}
}

/** Where a surface was first validly defined in the transcript. */
export interface A2uiSurfaceDefinitionSite {
	/** Index of the assistant message in the transcript array. */
	messageIndex: number;
	/** 0-based surface ordinal within that message (segmenter index). */
	surfaceIndex: number;
}

/**
 * Map of surfaceId → first VALID definition site, in transcript order
 * (spec § Fence robustness: duplicate `surfaceId` follows the v1.0 rule —
 * first valid definition wins, later duplicates render inert). Invalid
 * fences never claim an id. Derived purely from the transcript, so restore
 * and replay rebuild it with no separate store.
 */
export function deriveSurfaceDefinitions(
	messages: readonly TranscriptMessageLike[],
): ReadonlyMap<string, A2uiSurfaceDefinitionSite> {
	const definitions = new Map<string, A2uiSurfaceDefinitionSite>();
	const claimed = new Set<string>();
	messages.forEach((message, messageIndex) => {
		// Only assistant messages define surfaces (T08 scope guard).
		if (message.role !== "assistant") return;
		extractA2uiFences(message.text).forEach((fence, surfaceIndex) => {
			if (!fence.closed) return;
			const result = validateA2uiFence(fence.body, {
				existingSurfaceIds: claimed,
			});
			if (result.kind !== "valid") return;
			claimed.add(result.surface.surfaceId);
			definitions.set(result.surface.surfaceId, {
				messageIndex,
				surfaceIndex,
			});
		});
	});
	return definitions;
}

/**
 * The most recently defined valid surface in the session, or null. Relies on
 * Map insertion order — deriveSurfaceDefinitions registers in transcript
 * order, so the last key is the conversation's current fork.
 */
export function deriveLatestSurfaceId(
	definitions: ReadonlyMap<string, A2uiSurfaceDefinitionSite>,
): string | null {
	let latest: string | null = null;
	for (const key of definitions.keys()) latest = key;
	return latest;
}
