import * as React from "react";
const { useState, useCallback } = React;
import { setIcon } from "obsidian";
import type { ChatMessage, MessageContent } from "../types/chat";
import type { AcpClient } from "../acp/acp-client";
import type AgentClientPlugin from "../plugin";
import { deriveNewLeaf } from "../utils/link-leaf";
import { MarkdownRenderer } from "./shared/MarkdownRenderer";
import { TerminalBlock } from "./TerminalBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { LucideIcon } from "./shared/IconButton";
import { A2uiSurfaceHost } from "./A2uiSurfaceHost";
import { segmentAssistantMessage } from "../services/a2ui/segmenter";
import { deriveA2uiActionMessageView } from "../services/a2ui/action";
import type { A2uiButton } from "../services/a2ui/action";
import type { A2uiValidatedSurface } from "../services/a2ui/types";
import type { A2uiDispatchOutcome } from "../services/session-dispatch-port";
import type { TabSessionState } from "../types/tab";
import { t } from "../i18n";

// ---------------------------------------------------------------------------
// TextWithMentions (internal helper)
// ---------------------------------------------------------------------------

interface TextWithMentionsProps {
	text: string;
	plugin: AgentClientPlugin;
	autoMentionContext?: {
		noteName: string;
		notePath: string;
		selection?: {
			fromLine: number;
			toLine: number;
		};
	};
}

// Function to render text with @mentions and optional auto-mention
function TextWithMentions({
	text,
	plugin,
	autoMentionContext,
}: TextWithMentionsProps): React.ReactElement {
	// Match @[[filename]] format only
	const mentionRegex = /@\[\[([^\]]+)\]\]/g;
	const parts: React.ReactNode[] = [];

	// Resolve mentions relative to the active file so an ambiguous
	// basename resolves deterministically, and pass it through as the
	// link source for opening (C).
	const sourcePath = plugin.app.workspace.getActiveFile()?.path ?? "";

	// Add auto-mention badge first if provided
	if (autoMentionContext) {
		const displayText = autoMentionContext.selection
			? `@${autoMentionContext.noteName}:${autoMentionContext.selection.fromLine}-${autoMentionContext.selection.toLine}`
			: `@${autoMentionContext.noteName}`;

		parts.push(
			<span
				key="auto-mention"
				className="agent-client-text-mention"
				role="link"
				tabIndex={0}
				onClick={(e) => {
					void plugin.app.workspace.openLinkText(
						autoMentionContext.notePath,
						sourcePath,
						deriveNewLeaf(e.nativeEvent),
					);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						void plugin.app.workspace.openLinkText(
							autoMentionContext.notePath,
							sourcePath,
							"tab",
						);
					}
				}}
				onAuxClick={(e) => {
					if (e.button !== 1) return;
					e.preventDefault();
					void plugin.app.workspace.openLinkText(
						autoMentionContext.notePath,
						sourcePath,
						"tab",
					);
				}}
			>
				{displayText}
			</span>,
		);
		parts.push("\n");
	}

	let lastIndex = 0;
	let match;

	while ((match = mentionRegex.exec(text)) !== null) {
		// Add text before the mention
		if (match.index > lastIndex) {
			parts.push(text.slice(lastIndex, match.index));
		}

		// Extract filename from [[brackets]]
		const noteName = match[1];

		// Resolve via Obsidian's link resolver (handles ambiguous
		// basenames relative to the active file) instead of first-match.
		const file = plugin.app.metadataCache.getFirstLinkpathDest(
			noteName,
			sourcePath,
		);

		if (file) {
			// File exists - render as clickable mention
			parts.push(
				<span
					key={match.index}
					className="agent-client-text-mention"
					role="link"
					tabIndex={0}
					onClick={(e) => {
						void plugin.app.workspace.openLinkText(
							file.path,
							sourcePath,
							deriveNewLeaf(e.nativeEvent),
						);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							void plugin.app.workspace.openLinkText(
								file.path,
								sourcePath,
								"tab",
							);
						}
					}}
					onAuxClick={(e) => {
						if (e.button !== 1) return;
						e.preventDefault();
						void plugin.app.workspace.openLinkText(
							file.path,
							sourcePath,
							"tab",
						);
					}}
				>
					@{noteName}
				</span>,
			);
		} else {
			// File doesn't exist - render as plain text
			parts.push(`@${noteName}`);
		}

		lastIndex = match.index + match[0].length;
	}

	// Add any remaining text
	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	return <div className="agent-client-text-with-mentions">{parts}</div>;
}

// ---------------------------------------------------------------------------
// CollapsibleThought (internal helper)
// ---------------------------------------------------------------------------

interface CollapsibleThoughtProps {
	text: string;
	plugin: AgentClientPlugin;
}

function CollapsibleThought({ text, plugin }: CollapsibleThoughtProps) {
	const [isExpanded, setIsExpanded] = useState(false);
	const showEmojis = plugin.settings.displaySettings.showEmojis;

	return (
		<div
			className="agent-client-collapsible-thought"
			role="button"
			tabIndex={0}
			onClick={() => setIsExpanded(!isExpanded)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					setIsExpanded(!isExpanded);
				}
			}}
			aria-expanded={isExpanded}
		>
			<div className="agent-client-collapsible-thought-header">
				{showEmojis && (
					<LucideIcon
						name="lightbulb"
						className="agent-client-collapsible-thought-label-icon"
					/>
				)}
				Thinking
				<LucideIcon
					name={isExpanded ? "chevron-down" : "chevron-right"}
					className="agent-client-collapsible-thought-icon"
				/>
			</div>
			{isExpanded && (
				<div className="agent-client-collapsible-thought-content">
					<MarkdownRenderer text={text} plugin={plugin} />
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// A2UI (agent-emitted interactive prompts) wiring
// ---------------------------------------------------------------------------

/**
 * Everything the a2ui surface hosts need from the tab, threaded through
 * MessageList from ChatPanel. Optional on MessageBubbleProps: consumers that
 * don't wire it (exports, previews) render fences as ordinary markdown —
 * the T07 graceful-degradation path by construction.
 */
export interface A2uiBubbleContext {
	/** surfaceId → chosen componentId, derived from the transcript. */
	answers: ReadonlyMap<string, string>;
	/**
	 * First-valid-definition check (duplicate surfaceIds render inert). The
	 * site identifies WHICH fence asks: transcript message index + surface
	 * ordinal within the message (segmenter index).
	 */
	isFirstDefinition: (
		surfaceId: string,
		site: { messageIndex: number; surfaceIndex: number },
	) => boolean;
	/** The latest validly-defined surfaceId in the session (null = none). */
	latestSurfaceId: string | null;
	isSending: boolean;
	isQueued: boolean;
	isRestoringSession: boolean;
	/** Per-tab session lifecycle state (drives reconnect-on-click, A2UI-I08). */
	sessionState: TabSessionState;
	/** surfaceId of an action held for reconnect, or null. */
	heldSurfaceId: string | null;
	/** Build + dispatch the action; the outcome drives the pending lifecycle. */
	onActivate: (
		surface: A2uiValidatedSurface,
		button: A2uiButton,
	) => Promise<A2uiDispatchOutcome>;
}

/**
 * Assistant text with a2ui segmentation (D11): markdown segments go through
 * MarkdownRenderer as before; closed a2ui fences mount surface hosts as
 * SIBLINGS so streaming re-renders never unmount them.
 */
function AssistantTextWithSurfaces({
	text,
	plugin,
	a2ui,
	isStreamingTurn,
	messageIndex,
}: {
	text: string;
	plugin: AgentClientPlugin;
	a2ui: A2uiBubbleContext;
	isStreamingTurn: boolean;
	messageIndex: number;
}): React.ReactElement {
	const segments = segmentAssistantMessage(text);
	return (
		<>
			{segments.map((segment, i) =>
				segment.kind === "markdown" ? (
					<MarkdownRenderer
						key={`md-${i}`}
						text={segment.text}
						plugin={plugin}
					/>
				) : (
					<A2uiSurfaceHost
						key={`a2ui-${segment.index}`}
						body={segment.body}
						fenceText={segment.fenceText}
						plugin={plugin}
						answeredComponentId={answeredFor(a2ui.answers, segment.body)}
						isFirstDefinition={(surfaceId) =>
							a2ui.isFirstDefinition(surfaceId, {
								messageIndex,
								surfaceIndex: segment.index,
							})
						}
						isLatestDefinition={(surfaceId) =>
							a2ui.latestSurfaceId === null ||
							a2ui.latestSurfaceId === surfaceId
						}
						isSending={a2ui.isSending}
						isQueued={a2ui.isQueued}
						isRestoringSession={a2ui.isRestoringSession}
						isStreamingTurn={isStreamingTurn}
						sessionState={a2ui.sessionState}
						heldSurfaceId={a2ui.heldSurfaceId}
						onActivate={a2ui.onActivate}
					/>
				),
			)}
		</>
	);
}

/** Read the surfaceId off a fence body without full validation (answers lookup). */
function answeredFor(
	answers: ReadonlyMap<string, string>,
	body: string,
): string | null {
	try {
		const parsed = JSON.parse(body.trim()) as {
			createSurface?: { surfaceId?: unknown };
		};
		const surfaceId = parsed?.createSurface?.surfaceId;
		return typeof surfaceId === "string"
			? (answers.get(surfaceId) ?? null)
			: null;
	} catch {
		return null;
	}
}

/**
 * A user message that carries an a2ui action fence renders compactly (D14):
 * the human-readable summary line stays visible; the canonical envelope sits
 * behind a native disclosure whose summary is derived from the PAYLOAD, so a
 * deceptive label is inspectable. Fences in user messages never activate
 * (T08) — this is display only.
 */
function UserTextWithActions({
	text,
	plugin,
	autoMentionContext,
}: TextWithMentionsProps): React.ReactElement {
	// One resolver owns this decision (I179) — MessageBubble reads the same one
	// to publish the alignment modifier class, so the two cannot diverge.
	const view = deriveA2uiActionMessageView(text);
	if (view === null) {
		return (
			<TextWithMentions
				text={text}
				plugin={plugin}
				autoMentionContext={autoMentionContext}
			/>
		);
	}
	const { before, after, summary: payloadSummary } = view;
	return (
		<div className="agent-client-a2ui-action-message">
			{before.length > 0 && (
				<TextWithMentions text={before} plugin={plugin} />
			)}
			<details className="agent-client-a2ui-action-details">
				<summary>{payloadSummary}</summary>
				<pre className="agent-client-a2ui-action-envelope">
					{view.body}
				</pre>
			</details>
			{after.length > 0 && <TextWithMentions text={after} plugin={plugin} />}
		</div>
	);
}

// ---------------------------------------------------------------------------
// ContentBlock (internal helper, formerly MessageContentRenderer)
// ---------------------------------------------------------------------------

interface ContentBlockProps {
	content: MessageContent;
	plugin: AgentClientPlugin;
	messageRole?: "user" | "assistant";
	terminalClient?: AcpClient;
	/** a2ui wiring (optional — absent for consumers without the feature). */
	a2ui?: A2uiBubbleContext;
	/** The assistant turn containing this content is still streaming. */
	a2uiIsStreamingTurn?: boolean;
	/** This message's index in the transcript (for the definition registry). */
	a2uiMessageIndex?: number;
	/** Callback to approve a permission request */
	onApprovePermission?: (
		requestId: string,
		optionId: string,
	) => Promise<void>;
}

function ContentBlock({
	content,
	plugin,
	messageRole,
	terminalClient,
	onApprovePermission,
	a2ui,
	a2uiIsStreamingTurn,
	a2uiMessageIndex,
}: ContentBlockProps) {
	switch (content.type) {
		case "text":
			// User messages: render with mention support (a2ui action fences
			// display compactly but never activate — T08).
			if (messageRole === "user") {
				if (a2ui !== undefined) {
					return (
						<UserTextWithActions
							text={content.text}
							plugin={plugin}
						/>
					);
				}
				return <TextWithMentions text={content.text} plugin={plugin} />;
			}
			// Assistant messages: markdown, with a2ui fences mounted as
			// sibling surface hosts when the feature is wired (D11).
			if (a2ui !== undefined) {
				return (
					<AssistantTextWithSurfaces
						text={content.text}
						plugin={plugin}
						a2ui={a2ui}
						isStreamingTurn={a2uiIsStreamingTurn ?? false}
						messageIndex={a2uiMessageIndex ?? 0}
					/>
				);
			}
			return <MarkdownRenderer text={content.text} plugin={plugin} />;

		case "text_with_context":
			// User messages with auto-mention context
			return (
				<TextWithMentions
					text={content.text}
					autoMentionContext={content.autoMentionContext}
					plugin={plugin}
				/>
			);

		case "agent_thought":
			return <CollapsibleThought text={content.text} plugin={plugin} />;

		case "tool_call":
			return (
				<ToolCallBlock
					content={content}
					plugin={plugin}
					terminalClient={terminalClient}
					onApprovePermission={onApprovePermission}
				/>
			);

		case "plan": {
			const showEmojis = plugin.settings.displaySettings.showEmojis;
			return (
				<div className="agent-client-message-plan">
					<div className="agent-client-message-plan-title">
						{showEmojis && (
							<LucideIcon
								name="list-checks"
								className="agent-client-message-plan-label-icon"
							/>
						)}
						Plan
					</div>
					{content.entries.map((entry, idx) => (
						<div
							key={idx}
							className={`agent-client-message-plan-entry agent-client-plan-status-${entry.status}`}
						>
							{showEmojis && (
								<span
									className={`agent-client-message-plan-entry-icon agent-client-status-${entry.status}`}
								>
									<LucideIcon
										name={
											entry.status === "completed"
												? "check"
												: entry.status === "in_progress"
													? "loader"
													: "circle"
										}
									/>
								</span>
							)}{" "}
							{entry.content}
						</div>
					))}
				</div>
			);
		}

		case "terminal":
			return (
				<TerminalBlock
					terminalId={content.terminalId}
					terminalClient={terminalClient || null}
				/>
			);

		case "image":
			return (
				<div className="agent-client-message-image">
					<img
						src={`data:${content.mimeType};base64,${content.data}`}
						alt={t("chat.messages.attachedImage")}
						className="agent-client-message-image-thumbnail"
					/>
				</div>
			);

		case "resource_link":
			return (
				<div className="agent-client-message-resource-link">
					<span
						className="agent-client-message-resource-link-icon"
						ref={(el) => {
							if (el) setIcon(el, "file");
						}}
					/>
					<span className="agent-client-message-resource-link-name">
						{content.name}
					</span>
				</div>
			);

		default:
			return <span>{t("chat.messages.unsupportedContent")}</span>;
	}
}

// ---------------------------------------------------------------------------
// MessageBubble (exported, formerly MessageRenderer)
// ---------------------------------------------------------------------------

export interface MessageBubbleProps {
	message: ChatMessage;
	plugin: AgentClientPlugin;
	terminalClient?: AcpClient;
	/** Callback to approve a permission request */
	onApprovePermission?: (
		requestId: string,
		optionId: string,
	) => Promise<void>;
	/** a2ui wiring (optional — absent renders fences as plain markdown). */
	a2ui?: A2uiBubbleContext;
	/** The assistant turn this message belongs to is still streaming. */
	a2uiIsStreamingTurn?: boolean;
	/** This message's index in the transcript (for the definition registry). */
	a2uiMessageIndex?: number;
}

/**
 * Extract plain text from message contents for clipboard copy.
 */
function extractTextContent(contents: MessageContent[]): string {
	return contents
		.filter((c) => c.type === "text" || c.type === "text_with_context")
		.map((c) => ("text" in c ? c.text : ""))
		.join("\n");
}

/**
 * Copy button that shows a check icon briefly after copying.
 * Uses callback ref for Obsidian's setIcon DOM manipulation.
 */
function CopyButton({ contents }: { contents: MessageContent[] }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		const text = extractTextContent(contents);
		if (!text) return;
		void navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 2000);
			})
			.catch(() => {});
	}, [contents]);

	const iconRef = useCallback(
		(el: HTMLButtonElement | null) => {
			if (el) setIcon(el, copied ? "check" : "copy");
		},
		[copied],
	);

	return (
		<button
			className="clickable-icon agent-client-message-action-button"
			onClick={handleCopy}
			aria-label={t("chat.messages.copyMessage")}
			ref={iconRef}
		/>
	);
}

/**
 * Group consecutive image/resource_link contents together for horizontal display.
 * Non-attachment contents are wrapped individually.
 */
function groupContent(
	contents: MessageContent[],
): Array<
	| { type: "attachments"; items: MessageContent[] }
	| { type: "single"; item: MessageContent }
> {
	const groups: Array<
		| { type: "attachments"; items: MessageContent[] }
		| { type: "single"; item: MessageContent }
	> = [];

	let currentAttachmentGroup: MessageContent[] = [];

	for (const content of contents) {
		if (content.type === "image" || content.type === "resource_link") {
			currentAttachmentGroup.push(content);
		} else {
			// Flush any pending attachment group
			if (currentAttachmentGroup.length > 0) {
				groups.push({
					type: "attachments",
					items: currentAttachmentGroup,
				});
				currentAttachmentGroup = [];
			}
			groups.push({ type: "single", item: content });
		}
	}

	// Flush remaining attachments
	if (currentAttachmentGroup.length > 0) {
		groups.push({ type: "attachments", items: currentAttachmentGroup });
	}

	return groups;
}

export const MessageBubble = React.memo(function MessageBubble({
	message,
	plugin,
	terminalClient,
	onApprovePermission,
	a2ui,
	a2uiIsStreamingTurn,
	a2uiMessageIndex,
}: MessageBubbleProps) {
	const groups = groupContent(message.content);

	// I179 — publish the A2UI action condition as a class so the A2UI-I04
	// alignment rule can key off it instead of a CSS `:has` pseudo-class
	// (flagged by Obsidian's plugin review for broad selector invalidation).
	// This reproduces exactly what the old selector matched: a user bubble in
	// which some text block actually renders the compact action body — which
	// requires the a2ui feature to be wired, same as the rendering path below.
	const isA2uiActionMessage =
		message.role === "user" &&
		a2ui !== undefined &&
		message.content.some(
			(content) =>
				content.type === "text" &&
				deriveA2uiActionMessageView(content.text) !== null,
		);

	const roleClass =
		message.role === "user"
			? "agent-client-message-user"
			: "agent-client-message-assistant";

	return (
		<div
			className={`agent-client-message-renderer ${roleClass}${
				isA2uiActionMessage ? " agent-client-message-a2ui-action" : ""
			}`}
		>
			{groups.map((group, idx) => {
				if (group.type === "attachments") {
					// Render attachments (images + resource_links) in horizontal strip
					return (
						<div
							key={idx}
							className="agent-client-message-images-strip"
						>
							{group.items.map((content, imgIdx) => (
								<ContentBlock
									key={imgIdx}
									content={content}
									plugin={plugin}
									messageRole={message.role}
									terminalClient={terminalClient}
									onApprovePermission={onApprovePermission}
									a2ui={a2ui}
									a2uiIsStreamingTurn={a2uiIsStreamingTurn}
									a2uiMessageIndex={a2uiMessageIndex}
								/>
							))}
						</div>
					);
				} else {
					// Render single non-image content
					return (
						<div key={idx}>
							<ContentBlock
								content={group.item}
								plugin={plugin}
								messageRole={message.role}
								terminalClient={terminalClient}
								onApprovePermission={onApprovePermission}
								a2ui={a2ui}
								a2uiIsStreamingTurn={a2uiIsStreamingTurn}
								a2uiMessageIndex={a2uiMessageIndex}
							/>
						</div>
					);
				}
			})}
			{message.content.some(
				(c) =>
					(c.type === "text" || c.type === "text_with_context") &&
					c.text,
			) && (
				<div className="agent-client-message-actions">
					<CopyButton contents={message.content} />
				</div>
			)}
		</div>
	);
});
