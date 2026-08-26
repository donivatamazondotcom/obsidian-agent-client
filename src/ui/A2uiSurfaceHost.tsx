/**
 * A2uiSurfaceHost — mounts one agent-emitted buttons-v0 surface as a sibling
 * of the markdown segments (D11: never inside MarkdownRenderer, which
 * re-renders wholesale per streamed chunk). Stable identity is provided by
 * the caller's key: (sessionId, surfaceId).
 *
 * Trust boundary: the fence body is validated here, once per body change,
 * through the total no-throw validator. Anything invalid — malformed JSON,
 * out-of-profile components, duplicate surfaceIds — renders as the original
 * inert code block plus a muted reason (T06): no partial activation, ever.
 *
 * Keyboard-first: controls are real <button> elements — the platform owns
 * focus, the ring, and Enter/Space activation (repo rule: prefer native
 * button over div[role=button]).
 *
 * Enablement (D7) reads the same pure resolver the dispatch path gates on:
 * idle tab, empty queue slot, unanswered surface. Answered state arrives
 * from the transcript (deriveSurfaceAnswers) via props; local pending state
 * covers the dispatch window and re-enables on failure (T11).
 */
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { tooltipRef } from "./shared/useTooltip";
import type AgentClientPlugin from "../plugin";
import { validateA2uiFence } from "../services/a2ui/validator";
import { getLogger } from "../utils/logger";
import {
	deriveSurfaceActionAffordance,
	type A2uiActionAffordanceReason,
	type A2uiSurfaceStatus,
} from "../services/a2ui/surface-state";
import type { A2uiValidatedSurface } from "../services/a2ui/types";
import type { A2uiButton } from "../services/a2ui/action";
import type { A2uiDispatchOutcome } from "../services/session-dispatch-port";
import type { TabSessionState } from "../types/tab";
import { MarkdownRenderer } from "./shared/MarkdownRenderer";
import { t, type TranslationKey } from "../i18n";

export interface A2uiSurfaceHostProps {
	/** Fence body (candidate envelope line). */
	body: string;
	/** Verbatim fence block for the inert fallback rendering. */
	fenceText: string;
	plugin: AgentClientPlugin;
	/** Chosen componentId from the transcript, or null when unanswered. */
	answeredComponentId: string | null;
	/**
	 * Is this fence the FIRST valid definition of the given surfaceId in the
	 * session? Later duplicates render inert (first wins — v1.0 rule). Called
	 * post-validation with the actual surfaceId; default true (no registry).
	 */
	isFirstDefinition?: (surfaceId: string) => boolean;
	/**
	 * Is this surface the LATEST defined in the session? Earlier unanswered
	 * surfaces disable ("superseded") so choices track the conversation
	 * frontier. Default true (single-surface consumers).
	 */
	isLatestDefinition?: (surfaceId: string) => boolean;
	/** A turn is streaming somewhere in this tab. */
	isSending: boolean;
	/** The queue-of-one slot is occupied. */
	isQueued: boolean;
	/** Session history is loading. */
	isRestoringSession: boolean;
	/** The assistant turn containing this surface is still streaming. */
	isStreamingTurn: boolean;
	/** Per-tab session lifecycle state (drives the reconnect-on-click path). */
	sessionState: TabSessionState;
	/**
	 * surfaceId of an action currently HELD for reconnect (A2UI-I08), or null.
	 * Owned by the queue slot rather than this component, so if reconnecting
	 * fails and the slot is released, the surface re-enables on its own.
	 */
	heldSurfaceId?: string | null;
	/**
	 * Dispatch the activation (build envelope + detached send). The outcome
	 * drives the pending lifecycle: `sent` stays pending until the answer
	 * arrives in the transcript, `held` hands pending to the queue, and
	 * `refused`/`failed` re-enable the surface (T11).
	 */
	onActivate: (
		surface: A2uiValidatedSurface,
		button: A2uiButton,
	) => Promise<A2uiDispatchOutcome>;
}

/** Plain-language disabled reasons (user-facing copy rule: no jargon). */
const DISABLED_COPY_KEYS: Record<
	Exclude<A2uiActionAffordanceReason, "ready" | "reconnect">,
	TranslationKey
> = {
	streaming: "chat.a2ui.disabledStreaming",
	sending: "chat.a2ui.disabledSending",
	permission: "chat.a2ui.disabledPermission",
	queued: "chat.a2ui.disabledQueued",
	restoring: "chat.a2ui.disabledRestoring",
	pending: "chat.a2ui.disabledPending",
	answered: "chat.a2ui.disabledAnswered",
	superseded: "chat.a2ui.disabledSuperseded",
};

export function A2uiSurfaceHost(props: A2uiSurfaceHostProps): React.JSX.Element {
	const { body, fenceText, plugin, answeredComponentId } = props;

	const validation = useMemo(() => validateA2uiFence(body), [body]);
	const [pending, setPending] = useState(false);

	const duplicate =
		validation.kind === "valid" &&
		props.isFirstDefinition !== undefined &&
		!props.isFirstDefinition(validation.surface.surfaceId);

	// Dev diagnostics: when a fence renders inert, log WHY on the debug-gated
	// logger. A2uiViolation.detail is intentionally kept out of the transcript
	// (never rendered to the agent); the console is the one diagnosable channel
	// for authoring mistakes like a dangling child reference. Keyed on the
	// memoized validation (per body change), not per render.
	useEffect(() => {
		if (validation.kind === "invalid") {
			getLogger().debug(
				"a2ui surface rendered inert:",
				validation.violations
					.map((v) => `${v.code} (${v.detail})`)
					.join("; "),
			);
		} else if (duplicate) {
			getLogger().debug(
				`a2ui surface "${validation.surface.surfaceId}" rendered inert: duplicate surfaceId (first definition wins)`,
			);
		}
	}, [validation, duplicate]);

	if (validation.kind !== "valid" || duplicate) {
		return (
			<div className="agent-client-a2ui-inert">
				<MarkdownRenderer text={fenceText} plugin={plugin} />
				<div className="agent-client-a2ui-inert-reason">{t("chat.a2ui.inertReason")}</div>
			</div>
		);
	}
	const surface = validation.surface;

	// Pending covers the dispatch window. It comes from two places: local state
	// (the same-tick dispatch) and the queue slot (an action held while the
	// agent reconnects — A2UI-I08). Sourcing the held case from the slot means a
	// failed reconnect releases it and the surface re-enables without this
	// component having to observe the failure.
	const heldHere =
		props.heldSurfaceId !== undefined &&
		props.heldSurfaceId !== null &&
		props.heldSurfaceId === surface.surfaceId;

	const status: A2uiSurfaceStatus =
		answeredComponentId !== null
			? "answered"
			: pending || heldHere
				? "pending"
				: "unanswered";
	const affordance = deriveSurfaceActionAffordance({
		sessionState: props.sessionState,
		isSending: props.isSending,
		isQueued: props.isQueued,
		isRestoringSession: props.isRestoringSession,
		isStreamingTurn: props.isStreamingTurn,
		surfaceStatus: status,
		isSuperseded:
			props.isLatestDefinition !== undefined &&
			!props.isLatestDefinition(surface.surfaceId),
	});

	const handleActivate = (button: A2uiButton): void => {
		if (!affordance.enabled) return;
		setPending(true);
		void props.onActivate(surface, button).then((outcome) => {
			// sent  → stay pending; the answered state arrives from the
			//         transcript (the sent user message) and supersedes it.
			// held  → the queue slot now owns pending (heldSurfaceId), so drop
			//         the local flag and let that derived signal drive it.
			// else  → refused/failed: re-enable (T11).
			if (outcome !== "sent") setPending(false);
		});
	};

	const renderNode = (id: string): React.ReactNode => {
		const component = surface.components.get(id);
		if (component === undefined) return null;
		switch (component.kind) {
			case "text":
				// Plain text by design — never markdown inside controls (D12).
				return (
					<span key={id} className="agent-client-a2ui-text">
						{component.text}
					</span>
				);
			case "divider":
				return <hr key={id} className="agent-client-a2ui-divider" />;
			case "container": {
				const cls =
					component.component === "Card"
						? "agent-client-a2ui-card"
						: component.component === "Row"
							? "agent-client-a2ui-row"
							: "agent-client-a2ui-column";
				return (
					<div key={id} className={cls}>
						{component.children.map(renderNode)}
					</div>
				);
			}
			case "button": {
				const isChosen = answeredComponentId === component.id;
				const disabled = !affordance.enabled;
				// "ready" needs no explanation. "reconnect" is ENABLED — the
				// copy is a hint about what the click will do, not a refusal.
				const reason =
					affordance.reason === "ready"
						? undefined
						: affordance.reason === "reconnect"
							? t("chat.a2ui.hintReconnect")
							: heldHere && affordance.reason === "pending"
								? t("chat.a2ui.pendingReconnect")
								: t(DISABLED_COPY_KEYS[affordance.reason]);
				const className = [
					"agent-client-a2ui-button",
					isChosen ? "agent-client-a2ui-button-chosen mod-cta" : "",
					status === "answered" && !isChosen
						? "agent-client-a2ui-button-muted"
						: "",
				]
					.filter(Boolean)
					.join(" ");
				return (
					<button
						key={id}
						className={className}
						disabled={disabled}
						// This is where the tooltip rules were first worked out
						// (A2UI-I08): Obsidian's tooltip, never the `title`
						// attribute, and the text must keep the button's visible
						// label or the accessible name loses it. Those rules now
						// live in the shared helper, so every surface gets them
						// — including the locale-aware separator, which was
						// hardcoded here (I199). `reason === undefined` (live +
						// idle) resolves to "clear any stale tooltip".
						ref={tooltipRef({
							visibleLabel: component.label,
							reason: reason ?? null,
						})}
						onClick={() => handleActivate(component)}
					>
						{component.label}
					</button>
				);
			}
		}
	};

	return (
		<div className="agent-client-a2ui-surface" data-surface-id={surface.surfaceId}>
			{renderNode(surface.rootId)}
		</div>
	);
}
