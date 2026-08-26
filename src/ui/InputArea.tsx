import * as React from "react";
const { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo } =
	React;
import { Notice, setIcon } from "obsidian";

import type AgentClientPlugin from "../plugin";
import type { IChatViewHost } from "./view-host";
import type { NoteMetadata } from "../services/vault-service";
import type {
	SlashCommand,
	SessionModeState,
	SessionModelState,
	SessionUsage,
	SessionConfigOption,
} from "../types/session";
import type { AttachedFile, ChatMessage } from "../types/chat";
import type { UseSuggestionsReturn } from "../hooks/useSuggestions";
import {
	noteToPickerItem,
	slashCommandToPickerItem,
	quickPromptToPickerItem,
	mentionInstructions,
	slashInstructions,
	quickPromptInstructions,
} from "../utils/picker-sources";
import type { ActivePicker } from "../types/picker";
import { SuggestionPopup } from "./SuggestionPopup";
import { QuickPromptBar } from "./QuickPromptBar";
import {
	quickPromptGestureFromEvent,
	isQuickPromptScopeCombo,
} from "../utils/quick-prompt-gesture";
import type { QuickPrompt } from "../types/quick-prompt";
import type { QuickPromptGesture } from "../services/quick-prompts-logic";
import { ErrorBanner } from "./ErrorBanner";
import { AttachmentStrip } from "./shared/AttachmentStrip";
import { InputToolbar } from "./InputToolbar";
import { deriveSendAffordance } from "../resolvers/send-affordance";
import type { TabSessionState } from "../hooks/useTabSessionState";
import { focusComposerAtEnd } from "./composer-focus";
import { getLogger } from "../utils/logger";
import { pushScopeWhileFocused } from "../utils/focus-scoped-push";
import { decideComposerEnterAction, buildComposerPlaceholder, buildQueuedBanner, isQueuedSendBlocked, isSteerGesture } from "../services/message-queue-logic";
import { MOD_KEY, SHIFT_KEY, ENTER_KEY, modCombo } from "../utils/platform";
import type { ErrorInfo } from "../types/errors";
import type { AgentUpdateNotification } from "../services/update-checker";
import { useSettings } from "../hooks/useSettings";
import { classifyImagePaste } from "../utils/image-paste";
import { t } from "../i18n";
import {
	clampTextareaHeight,
	decideTextareaResize,
	TEXTAREA_MIN_HEIGHT,
} from "../utils/textarea-autosize";

// ============================================================================
// Image Constants
// ============================================================================

/** Maximum image size in MB */
const MAX_IMAGE_SIZE_MB = 5;

/** Maximum image size in bytes */
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

/** Maximum number of attachments per message (images + files combined) */
const MAX_ATTACHMENT_COUNT = 10;

/** Supported image MIME types (whitelist) */
const SUPPORTED_IMAGE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/**
 * Props for InputArea component
 */
// ============================================================================
// Input History Hook
// ============================================================================

/**
 * Hook for navigating through previous user messages with ArrowUp/ArrowDown.
 */
function useInputHistory(
	messages: ChatMessage[],
	onInputChange: (value: string) => void,
): {
	handleHistoryKeyDown: (
		e: React.KeyboardEvent,
		textareaEl: HTMLTextAreaElement | null,
	) => boolean;
	resetHistory: () => void;
} {
	const historyIndexRef = useRef(-1);
	const restoredTextRef = useRef<string | null>(null);

	const userMessages = useMemo(() => {
		return messages
			.filter((m) => m.role === "user")
			.map((m) => {
				const textContent = m.content.find(
					(c) => c.type === "text" || c.type === "text_with_context",
				);
				return textContent && "text" in textContent
					? textContent.text
					: "";
			})
			.filter((text) => text.trim() !== "");
	}, [messages]);

	const handleHistoryKeyDown = useCallback(
		(
			e: React.KeyboardEvent,
			textareaEl: HTMLTextAreaElement | null,
		): boolean => {
			if (!textareaEl) return false;
			if (e.nativeEvent.isComposing) return false;
			if (userMessages.length === 0) return false;

			// Exit history mode if user edited text or moved cursor
			if (historyIndexRef.current !== -1) {
				if (
					e.key === "ArrowLeft" ||
					e.key === "ArrowRight" ||
					(restoredTextRef.current !== null &&
						textareaEl.value !== restoredTextRef.current)
				) {
					historyIndexRef.current = -1;
					restoredTextRef.current = null;
					return false;
				}
			}

			if (e.key === "ArrowUp") {
				if (
					textareaEl.value.trim() !== "" &&
					historyIndexRef.current === -1
				)
					return false;

				e.preventDefault();

				const nextIndex = historyIndexRef.current + 1;
				if (nextIndex >= userMessages.length) {
					return true;
				}

				historyIndexRef.current = nextIndex;
				const messageText =
					userMessages[userMessages.length - 1 - nextIndex];
				restoredTextRef.current = messageText;
				onInputChange(messageText);

				window.setTimeout(() => {
					textareaEl.selectionStart = messageText.length;
					textareaEl.selectionEnd = messageText.length;
				}, 0);

				return true;
			}

			if (e.key === "ArrowDown") {
				const currentIndex = historyIndexRef.current;
				if (currentIndex === -1) return false;

				e.preventDefault();

				const nextIndex = currentIndex - 1;
				historyIndexRef.current = nextIndex;

				if (nextIndex === -1) {
					restoredTextRef.current = null;
					onInputChange("");
				} else {
					const messageText =
						userMessages[userMessages.length - 1 - nextIndex];
					restoredTextRef.current = messageText;
					onInputChange(messageText);

					window.setTimeout(() => {
						textareaEl.selectionStart = messageText.length;
						textareaEl.selectionEnd = messageText.length;
					}, 0);
				}

				return true;
			}

			return false;
		},
		[userMessages, onInputChange],
	);

	const resetHistory = useCallback(() => {
		historyIndexRef.current = -1;
		restoredTextRef.current = null;
	}, []);

	return { handleHistoryKeyDown, resetHistory };
}

// ============================================================================
// InputArea Component
// ============================================================================

export interface InputAreaProps {
	/** Whether a message is currently being sent */
	isSending: boolean;
	/** Whether the session is ready for user input */
	isSessionReady: boolean;
	/** Per-tab lazy session state (canonical readiness signal for send affordance) */
	lazyState: TabSessionState;
	/** Whether a session is being restored (load/resume/fork) */
	isRestoringSession: boolean;
	/** Display name of the active agent */
	agentLabel: string;
	/** Available slash commands */
	availableCommands: SlashCommand[];
	/** Message to restore (e.g., after cancellation) */
	restoredMessage: string | null;
	/** Input suggestions (mentions + slash commands) */
	suggestions: UseSuggestionsReturn;
	/** Plugin instance */
	plugin: AgentClientPlugin;
	/** View instance for event registration */
	view: IChatViewHost;
	/** Composer textarea node, registered for focus-return after state changes. */
	composerElRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
	/** Callback to send a message with optional attachments */
	onSendMessage: (
		content: string,
		attachments?: AttachedFile[],
	) => Promise<void>;
	/** Callback to stop the current generation */
	onStopGeneration: () => Promise<void>;
	/** Callback when restored message has been consumed */
	onRestoredMessageConsumed: () => void;
	// Queue Next Message (#82)
	/** Whether the agent is currently streaming a reply (queue affordance window). */
	isStreaming?: boolean;
	/** Whether a message is queued (locks the composer + shows the queued banner). */
	isQueued?: boolean;
	/**
	 * The queued message is a DETACHED action from an interactive surface, not
	 * composer text (A2UI-I08). Changes the banner copy and replaces
	 * Edit/Delete with a Cancel that never touches the composer.
	 */
	isQueuedAction?: boolean;
	/** Queue the composer's current content (Enter while streaming). */
	onQueueMessage?: (content: string, attachments?: AttachedFile[]) => void;
	/** Unlock the composer to edit the queued message (keeps the text). */
	onEditQueued?: () => void;
	/** Delete the queued message and empty the composer. */
	onDeleteQueued?: () => void;
	// Mid-Stream Steering (#81)
	/** Whether a steer (cancel-then-redirect) is in flight — shows a distinct banner. */
	isSteering?: boolean;
	/** Steer: cancel the live turn and send the composer text as the next prompt. */
	onSteerMessage?: (content: string, attachments?: AttachedFile[]) => void;
	/** Session mode state (available modes and current mode) */
	modes?: SessionModeState;
	/** Callback when mode is changed */
	onModeChange?: (modeId: string) => void;
	/** Session model state (available models and current model) - experimental */
	models?: SessionModelState;
	/** Callback when model is changed */
	onModelChange?: (modelId: string) => void;
	/** Session config options (supersedes modes/models when present) */
	configOptions?: SessionConfigOption[];
	/** Callback when a config option is changed */
	onConfigOptionChange?: (configId: string, value: string) => void;
	/** Context window usage (shown as percentage indicator) */
	usage?: SessionUsage;
	/** Whether the agent supports image attachments */
	supportsImages?: boolean;
	/**
	 * Whether the agent's image capability is known yet. False during the
	 * fresh-tab init window before promptCapabilities resolves (I72).
	 */
	imageCapabilityKnown?: boolean;
	/** Current agent ID (used to clear images on agent switch) */
	agentId: string;
	// Controlled component props (for broadcast commands)
	/** Current input text value */
	inputValue: string;
	/** Callback when input text changes */
	onInputChange: (value: string) => void;
	/** Currently attached files (images and non-image files) */
	attachedFiles: AttachedFile[];
	/** Callback when attached files change */
	onAttachedFilesChange: (files: AttachedFile[]) => void;
	/** Error information to display as overlay */
	errorInfo: ErrorInfo | null;
	/** Callback to clear the error */
	onClearError: () => void;
	/** Agent update notification (version update or migration) */
	agentUpdateNotification: AgentUpdateNotification | null;
	/** Callback to dismiss the agent update notification */
	onClearAgentUpdate: () => void;
	/** Messages array for input history navigation */
	messages: ChatMessage[];
	/** Whether this tab is the currently active tab (focuses textarea on activation) */
	isActive?: boolean;
	/** Resting chip set (already matched to the active note) for the chips row. */
	quickPromptPrompts?: QuickPrompt[];
	/** Whether this tab holds a pending queued message (disables current-tab chips). */
	quickPromptHasPendingQueue?: boolean;
	/** Whether any quick prompts exist (drives the composer placeholder hint). */
	hasQuickPrompts?: boolean;
	/** Fire/insert a quick prompt from the composer ! trigger (engine 2×2). */
	onRunQuickPrompt?: (
		prompt: QuickPrompt,
		gesture: QuickPromptGesture,
		composerAfterStrip?: string,
	) => void;
	/** Create a new quick prompt from the ! create row (optionally from the composer draft). */
	onCreateQuickPrompt?: (opts: { query: string; body?: string }) => void;
	/** Bumps when the "Quick prompts: Search" command fires — focuses + inserts !. */
	quickPromptSearchSignal?: number;
	/**
	 * The composer is a LAUNCHER (zero-tab landing): Enter dispatches a NEW-tab
	 * launch, not a send into this (non-existent) session. Threaded from
	 * `deriveComposerAffordances({surface:"landing"}).sendMode === "launch"` by
	 * ZeroTabLanding. When true, `decideComposerEnterAction` must NOT route
	 * `!isSessionReady` to "queue" (no session to connect/flush) — Enter
	 * dispatches → onSendMessage → the landing launch. Defaults to false
	 * (in-tab composer). See I169.
	 */
	launches?: boolean;
}

/**
 * Input component for the chat view.
 *
 * Handles:
 * - Text input with auto-resize
 * - Mention dropdown (@-mentions)
 * - Slash command dropdown (/-commands)
 * - Auto-mention badge
 * - Hint overlay for slash commands
 * - Send/stop button
 * - Keyboard navigation
 */
export function InputArea({
	isSending,
	isSessionReady,
	lazyState,
	isRestoringSession,
	agentLabel,
	availableCommands,
	restoredMessage,
	suggestions,
	plugin,
	view,
	composerElRef,
	onSendMessage,
	onStopGeneration,
	onRestoredMessageConsumed,
	isStreaming = false,
	isQueued = false,
	isQueuedAction = false,
	onQueueMessage,
	onEditQueued,
	onDeleteQueued,
	isSteering = false,
	onSteerMessage,
	modes,
	onModeChange,
	models,
	onModelChange,
	configOptions,
	onConfigOptionChange,
	usage,
	supportsImages = false,
	imageCapabilityKnown = false,
	agentId,
	// Controlled component props
	inputValue,
	onInputChange,
	attachedFiles,
	onAttachedFilesChange,
	// Error overlay props
	errorInfo,
	onClearError,
	// Agent update notification props
	agentUpdateNotification,
	onClearAgentUpdate,
	// Input history
	messages,
	isActive,
	quickPromptPrompts,
	quickPromptHasPendingQueue,
	hasQuickPrompts,
	onRunQuickPrompt,
	onCreateQuickPrompt,
	quickPromptSearchSignal,
	launches = false,
}: InputAreaProps) {
	const {
		mentions,
		commands: slashCommands,
		quickPrompts,
		activePicker: resolvedPicker,
	} = suggestions;
	const logger = getLogger();
	const settings = useSettings(plugin);
	const showEmojis = plugin.settings.displaySettings.showEmojis;

	// Unofficial Obsidian API (see src/types/obsidian-internals.d.ts)
	const obsidianSpellcheck =
		(plugin.app.vault.getConfig("spellcheck") as boolean | undefined) ?? true;

	// Local state (hint and command are still local - not needed for broadcast)
	const [hintText, setHintText] = useState<string | null>(null);
	const [commandText, setCommandText] = useState<string>("");
	const [isDraggingOver, setIsDraggingOver] = useState(false);

	const { handleHistoryKeyDown, resetHistory } = useInputHistory(
		messages,
		onInputChange,
	);

	// Refs
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	// Mirror the composer node out to the parent (ChatPanel) for focus-return
	// after in-panel state changes. See [[Composer Focus Return After State Change]].
	const setComposerNode = useCallback(
		(node: HTMLTextAreaElement | null) => {
			textareaRef.current = node;
			if (composerElRef) composerElRef.current = node;
		},
		[composerElRef],
	);
	const dragCounterRef = useRef(0);

	// Clear attached files when agent changes
	useEffect(() => {
		onAttachedFilesChange([]);
	}, [agentId, onAttachedFilesChange]);

	/**
	 * Add multiple attachments at once with limit enforcement.
	 * Single state update avoids stale closure issues.
	 */
	const addAttachments = useCallback(
		(newFiles: AttachedFile[]) => {
			if (newFiles.length === 0) return;
			const remaining = MAX_ATTACHMENT_COUNT - attachedFiles.length;
			if (remaining <= 0) {
				new Notice(
					t("notices.maxAttachments", { count: MAX_ATTACHMENT_COUNT }),
				);
				return;
			}
			const toAdd = newFiles.slice(0, remaining);
			if (toAdd.length < newFiles.length) {
				new Notice(
					t("notices.maxAttachments", { count: MAX_ATTACHMENT_COUNT }),
				);
			}
			onAttachedFilesChange([...attachedFiles, ...toAdd]);
		},
		[attachedFiles, onAttachedFilesChange],
	);

	/**
	 * Remove a file from the attached files list.
	 */
	const removeFile = useCallback(
		(id: string) => {
			onAttachedFilesChange(attachedFiles.filter((f) => f.id !== id));
			textareaRef.current?.focus();
		},
		[attachedFiles, onAttachedFilesChange],
	);

	/**
	 * Convert a File to Base64 string.
	 */
	const fileToBase64 = useCallback(async (file: File): Promise<string> => {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				// Extract base64 part from "data:image/png;base64,..."
				const base64 = result.split(",")[1];
				resolve(base64);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}, []);

	/**
	 * Convert image files to Base64 AttachedFile objects.
	 * Returns the converted attachments without updating state.
	 */
	const convertImagesToAttachments = useCallback(
		async (files: File[]): Promise<AttachedFile[]> => {
			const result: AttachedFile[] = [];
			for (const file of files) {
				if (file.size > MAX_IMAGE_SIZE_BYTES) {
					new Notice(
						t("notices.imageTooLarge", { size: MAX_IMAGE_SIZE_MB }),
					);
					continue;
				}
				try {
					const base64 = await fileToBase64(file);
					result.push({
						id: crypto.randomUUID(),
						kind: "image",
						data: base64,
						mimeType: file.type,
					});
				} catch (error) {
					getLogger().error("Failed to convert image:", error);
					new Notice(t("notices.imageAttachFailed"));
				}
			}
			return result;
		},
		[fileToBase64],
	);

	/**
	 * Convert files to resource_link AttachedFile objects.
	 * Returns the converted attachments without updating state.
	 */
	const convertFilesToAttachments = useCallback(
		(files: File[]): AttachedFile[] => {
			// Get file path via Electron's webUtils API (File.path was removed in Electron 32)
			// eslint-disable-next-line @typescript-eslint/no-require-imports -- electron is a runtime-only module provided by Obsidian's host environment
			const { webUtils } = require("electron") as {
				webUtils: { getPathForFile: (file: File) => string };
			};
			const result: AttachedFile[] = [];
			for (const file of files) {
				const filePath = webUtils.getPathForFile(file);
				if (!filePath) {
					new Notice(t("notices.filePathUndetermined"));
					continue;
				}
				result.push({
					id: crypto.randomUUID(),
					kind: "file",
					mimeType: file.type || "application/octet-stream",
					name: file.name,
					path: filePath,
					size: file.size,
				});
			}
			return result;
		},
		[],
	);

	/**
	 * Handle paste event for file attachment.
	 * Images are embedded as Base64 if agent supports it, otherwise sent as resource_link.
	 * Non-image files are sent as resource_link.
	 */
	const handlePaste = useCallback(
		async (e: React.ClipboardEvent) => {
			const items = e.clipboardData?.items;
			if (!items) return;

			// Extract files from clipboard, split by type
			const imageFiles: File[] = [];
			const nonImageFiles: File[] = [];

			for (const item of Array.from(items)) {
				if (item.kind !== "file") continue;
				const file = item.getAsFile();
				if (!file) continue;

				if (
					SUPPORTED_IMAGE_TYPES.includes(
						item.type as SupportedImageType,
					)
				) {
					imageFiles.push(file);
				} else {
					nonImageFiles.push(file);
				}
			}

			if (imageFiles.length === 0 && nonImageFiles.length === 0) return;

			e.preventDefault();

			const newAttachments: AttachedFile[] = [];

			if (imageFiles.length > 0) {
				const imageOutcome = classifyImagePaste({
					supportsImages,
					imageCapabilityKnown,
				});
				if (imageOutcome === "attach-as-image") {
					newAttachments.push(
						...(await convertImagesToAttachments(imageFiles)),
					);
				} else if (imageOutcome === "connecting") {
					// I72: capabilities not loaded yet — show an accurate
					// transient notice and skip these images (avoids the
					// spurious "Could not determine file path" fallback).
					new Notice(t("notices.imagePasteConnecting"));
				} else {
					// Caps known, images unsupported: try resource_link
					// fallback (works for files copied from Finder, not for
					// clipboard screenshots).
					const converted = convertFilesToAttachments(imageFiles);
					if (converted.length > 0) {
						newAttachments.push(...converted);
					} else {
						new Notice(t("notices.imagePasteUnsupported"));
					}
				}
			}

			if (nonImageFiles.length > 0) {
				newAttachments.push(
					...convertFilesToAttachments(nonImageFiles),
				);
			}

			addAttachments(newAttachments);
		},
		[
			supportsImages,
			imageCapabilityKnown,
			convertImagesToAttachments,
			convertFilesToAttachments,
			addAttachments,
		],
	);

	/**
	 * Handle drag over event to allow drop.
	 */
	const handleDragOver = useCallback((e: React.DragEvent) => {
		if (e.dataTransfer?.types.includes("Files")) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		}
	}, []);

	/**
	 * Handle drag enter event for visual feedback.
	 * Uses counter to handle child element enter/leave correctly.
	 */
	const handleDragEnter = useCallback((e: React.DragEvent) => {
		if (e.dataTransfer?.types.includes("Files")) {
			e.preventDefault();
			dragCounterRef.current++;
			if (dragCounterRef.current === 1) {
				setIsDraggingOver(true);
			}
		}
	}, []);

	/**
	 * Handle drag leave event to reset visual feedback.
	 */
	const handleDragLeave = useCallback((_e: React.DragEvent) => {
		dragCounterRef.current--;
		if (dragCounterRef.current === 0) {
			setIsDraggingOver(false);
		}
	}, []);

	/**
	 * Handle drop event for file attachments.
	 * Images are embedded as Base64 if agent supports it, otherwise sent as resource_link.
	 * Non-image files are always sent as resource_link.
	 */
	const handleDrop = useCallback(
		async (e: React.DragEvent) => {
			dragCounterRef.current = 0;
			setIsDraggingOver(false);

			const files = e.dataTransfer?.files;
			if (!files || files.length === 0) return;

			e.preventDefault();

			const droppedFiles = Array.from(files);
			const imageFiles: File[] = [];
			const nonImageFiles: File[] = [];

			for (const file of droppedFiles) {
				if (
					SUPPORTED_IMAGE_TYPES.includes(
						file.type as SupportedImageType,
					)
				) {
					imageFiles.push(file);
				} else if (file.type || file.name) {
					nonImageFiles.push(file);
				}
			}

			// Convert all files, then update state once
			const newAttachments: AttachedFile[] = [];

			if (imageFiles.length > 0) {
				const imageOutcome = classifyImagePaste({
					supportsImages,
					imageCapabilityKnown,
				});
				if (imageOutcome === "attach-as-image") {
					newAttachments.push(
						...(await convertImagesToAttachments(imageFiles)),
					);
				} else if (imageOutcome === "connecting") {
					// I72: capabilities not loaded yet — transient notice.
					new Notice(t("notices.imagePasteConnecting"));
				} else {
					// Dropped files have paths, so resource_link works even
					// for no-image agents.
					newAttachments.push(
						...convertFilesToAttachments(imageFiles),
					);
				}
			}

			if (nonImageFiles.length > 0) {
				newAttachments.push(
					...convertFilesToAttachments(nonImageFiles),
				);
			}

			addAttachments(newAttachments);
		},
		[
			supportsImages,
			imageCapabilityKnown,
			convertImagesToAttachments,
			convertFilesToAttachments,
			addAttachments,
		],
	);

	/**
	 * Common logic for setting cursor position after text replacement. When
	 * `cursorPos` is provided the caret lands there (e.g. the end of an inserted
	 * `@[[note]]` reference); otherwise it falls back to the end of the text.
	 */
	const setTextAndFocus = useCallback(
		(newText: string, cursorPos?: number) => {
			onInputChange(newText);

			// Apply the caret after the controlled re-render commits the value.
			window.setTimeout(() => {
				const textarea = textareaRef.current;
				if (textarea) {
					const pos = cursorPos ?? newText.length;
					textarea.selectionStart = pos;
					textarea.selectionEnd = pos;
					textarea.focus();
				}
			}, 0);
		},
		[onInputChange],
	);

	/**
	 * Handle mention selection from dropdown.
	 */
	const selectMention = useCallback(
		(suggestion: NoteMetadata) => {
			const { newText, newCursorPos } = mentions.selectSuggestion(
				inputValue,
				suggestion,
			);
			setTextAndFocus(newText, newCursorPos);
		},
		[mentions, inputValue, setTextAndFocus],
	);

	/**
	 * Fire a quick prompt chosen from the composer ! dropdown. The prompt is
	 * sent/staged via the engine (gesture → 2×2); the ! token is stripped
	 * from the composer, preserving any surrounding draft text.
	 */
	const selectQuickPrompt = useCallback(
		(
			prompt: QuickPrompt,
			evt?:
				| React.MouseEvent
				| React.KeyboardEvent
				| MouseEvent
				| KeyboardEvent,
		) => {
			// Strip the `!query` token FIRST and hand the stripped composer up so
			// ChatPanel can sync its composer ref BEFORE the engine evaluates
			// (QP-I13). Otherwise the `!query` token counts as a draft → the fire
			// is mis-routed to the unsent-draft insert, and the post-fire
			// setTextAndFocus would clobber it. ChatPanel now owns the composer
			// update (fire clears it / insert lands in it), so we do NOT
			// setTextAndFocus here.
			// `evt` may be a React synthetic (React path) or a native DOM event
			// (the QP-I14 Scope path); normalize to the native event the gesture
			// util reads.
			const native =
				evt && "nativeEvent" in evt ? evt.nativeEvent : evt;
			const { newText: stripped } =
				quickPrompts.selectSuggestion(inputValue);
			onRunQuickPrompt?.(
				prompt,
				quickPromptGestureFromEvent(native),
				stripped,
			);
		},
		[onRunQuickPrompt, quickPrompts, inputValue],
	);

	/**
	 * Create a new quick prompt from the ! create-on-no-match row, then strip
	 * the ! token from the composer (preserving any surrounding draft).
	 */
	const handleCreateQuickPrompt = useCallback(() => {
		const row = quickPrompts.createRow;
		if (!row) return;
		// selectSuggestion strips the `!query` token and returns the remaining
		// composer text (the draft, preserved — No-silent-data-loss).
		const { newText } = quickPrompts.selectSuggestion(inputValue);
		onCreateQuickPrompt?.({
			query: row.query,
			// QP-I11: a from-composer create captures the surviving draft as the
			// new prompt body; otherwise the note gets the placeholder body.
			body: row.fromComposer ? newText : undefined,
		});
		setTextAndFocus(newText);
	}, [quickPrompts, onCreateQuickPrompt, inputValue, setTextAndFocus]);

	/**
	 * Activate the highlighted quick-prompt dropdown row: the create row, or a
	 * prompt fired through the engine with the event’s gesture. Shared by the
	 * React keydown path and the pushed Scope (QP-I14) so both surfaces select
	 * identically. Returns true when it acted on an open quick-prompt dropdown.
	 */
	const activateQuickPromptSelection = useCallback(
		(evt: React.KeyboardEvent | KeyboardEvent): boolean => {
			if (!quickPrompts.isOpen) return false;
			if (
				quickPrompts.createRow &&
				quickPrompts.selectedIndex === quickPrompts.suggestions.length
			) {
				handleCreateQuickPrompt();
				return true;
			}
			const selectedPrompt =
				quickPrompts.suggestions[quickPrompts.selectedIndex];
			if (!selectedPrompt) return false;
			selectQuickPrompt(selectedPrompt, evt);
			return true;
		},
		[quickPrompts, handleCreateQuickPrompt, selectQuickPrompt],
	);

	// QP-I14: while the `!` quick-prompt dropdown is open, claim the Enter
	// combos Obsidian’s DEFAULT editor hotkeys steal (⌥ / ⌘ / ⌘⌥ / ⌘⌥⇧ + Enter
	// → follow-link / open-link-in-new-leaf|split|window). A Scope pushed onto
	// app.keymap outranks the global editor scope (the same mechanism that lets
	// ChatView’s Mod+W beat workspace:close), so these reach the quick-prompt
	// selection instead of being swallowed. Plain Enter and ⌘⇧Enter are NOT
	// bound by Obsidian and keep flowing through React’s handleDropdownKeyPress.
	// The scope lives only while the dropdown is open.
	const activateQuickPromptSelectionRef = useRef(activateQuickPromptSelection);
	activateQuickPromptSelectionRef.current = activateQuickPromptSelection;
	const quickPromptDropdownOpen = quickPrompts.isOpen;
	useEffect(() => {
		if (!quickPromptDropdownOpen) return;
		// Push only while the panel is focused, pop the instant focus leaves
		// (I161). The dropdown-open gate already implies focus, but routing
		// through the focus-gated helper states the invariant once and keeps
		// the view-scope fall-through (I155) from leaking Cmd+W to other leaves.
		return pushScopeWhileFocused(plugin.app, view, (scope) => {
			const handler = (evt: KeyboardEvent): false | void => {
				// Consume (preventDefault) when we acted on the dropdown;
				// otherwise return void so Obsidian falls through to its editor
				// hotkeys.
				if (activateQuickPromptSelectionRef.current(evt)) return false;
			};
			scope.register(["Alt"], "Enter", handler);
			scope.register(["Mod"], "Enter", handler);
			scope.register(["Mod", "Alt"], "Enter", handler);
			scope.register(["Mod", "Alt", "Shift"], "Enter", handler);
		});
	}, [quickPromptDropdownOpen, plugin, view]);

	/**
	 * Overflow "+N" affordance: focus the composer and start a ! search. Inserts
	 * a `!` at line start (a newline is prepended when there is existing draft text) and opens
	 * the quick-prompt dropdown.
	 */
	const handleSearchAll = useCallback(() => {
		const base = inputValue;
		const next =
			base.length === 0 || base.endsWith("\n") ? `${base}!` : `${base}\n!`;
		onInputChange(next);
		window.setTimeout(() => {
			const textarea = textareaRef.current;
			if (textarea) {
				const pos = next.length;
				textarea.selectionStart = pos;
				textarea.selectionEnd = pos;
				textarea.focus();
				quickPrompts.updateSuggestions(next, pos);
			}
		}, 0);
	}, [inputValue, onInputChange, quickPrompts]);

	// "Quick prompts: Search" command → run handleSearchAll on each signal bump
	// (ref so the effect gates only on the signal, not handleSearchAll identity).
	const handleSearchAllRef = useRef(handleSearchAll);
	handleSearchAllRef.current = handleSearchAll;
	const qpSearchSignalSeen = useRef(quickPromptSearchSignal);
	useEffect(() => {
		if (quickPromptSearchSignal === qpSearchSignalSeen.current) return;
		qpSearchSignalSeen.current = quickPromptSearchSignal;
		handleSearchAllRef.current();
	}, [quickPromptSearchSignal]);

	/**
	 * Handle slash command selection from dropdown.
	 */
	const handleSelectSlashCommand = useCallback(
		(command: SlashCommand) => {
			const { newText } = slashCommands.selectSuggestion(
				inputValue,
				command,
			);
			onInputChange(newText);

			// Setup hint overlay if command has hint
			if (command.hint) {
				const cmdText = `/${command.name} `;
				setCommandText(cmdText);
				setHintText(command.hint);
			} else {
				// No hint - clear hint state
				setHintText(null);
				setCommandText("");
			}

			// Place cursor right after command name (before hint text)
			window.setTimeout(() => {
				const textarea = textareaRef.current;
				if (textarea) {
					const cursorPos = command.hint
						? `/${command.name} `.length
						: newText.length;
					textarea.selectionStart = cursorPos;
					textarea.selectionEnd = cursorPos;
					textarea.focus();
				}
			}, 0);
		},
		[slashCommands, inputValue, onInputChange],
	);

	/**
	 * Adjust textarea height based on content.
	 *
	 * I-S13 fix: when the composer is OVERFLOWING (typing while tall / parked at
	 * max-height), `scrollHeight` already reports the true content height, so we
	 * size from it directly and never toggle `height: auto`. That toggle's
	 * momentary relayout — the composer is a flex sibling of the message list —
	 * made the browser revert the message list's scrollTop, which
	 * `useAutoScrollPin` misread as a user scroll-up and unpinned the chat. The
	 * `height: auto` collapse is now only used on the cold shrink path (content
	 * deleted), never on the hot typing path. Styles are written only when the
	 * height actually changes, so the overflow path touches no DOM in steady
	 * state. See utils/textarea-autosize.ts and
	 * 04-initiatives/Agent Console/ACP Scroll Architecture Rework.md § I-S13.
	 */
	const adjustTextareaHeight = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;

		const decision = decideTextareaResize({
			scrollHeight: textarea.scrollHeight,
			clientHeight: textarea.clientHeight,
		});

		let height: number;
		if (decision.kind === "apply") {
			// Overflowing: no height:auto toggle → no layout thrash.
			height = decision.heightPx;
		} else {
			// Cold shrink path: collapse once to measure the true content height.
			// Drop the expanded height FIRST — `.agent-client-textarea-expanded`
			// (`height: var(--textarea-height)`) sits later in the cascade than
			// `.agent-client-textarea-auto-height` (`height: auto`) at equal
			// specificity, so leaving it on would win and the element would NOT
			// collapse; the measurement would return the stale expanded height
			// and the composer could never shrink back down.
			textarea.classList.remove("agent-client-textarea-expanded");
			textarea.classList.add("agent-client-textarea-auto-height");
			const collapsed = textarea.scrollHeight;
			textarea.classList.remove("agent-client-textarea-auto-height");
			height = clampTextareaHeight(collapsed);
		}

		// Apply only when something actually changes, so the overflow path never
		// perturbs layout in steady state.
		const nextVar = height > TEXTAREA_MIN_HEIGHT ? `${height}px` : "";
		const currentVar = textarea.style.getPropertyValue("--textarea-height");
		if (nextVar) {
			if (
				currentVar !== nextVar ||
				!textarea.classList.contains("agent-client-textarea-expanded")
			) {
				textarea.classList.add("agent-client-textarea-expanded");
				textarea.style.setProperty("--textarea-height", nextVar);
			}
		} else if (
			currentVar ||
			textarea.classList.contains("agent-client-textarea-expanded")
		) {
			textarea.classList.remove("agent-client-textarea-expanded");
			textarea.style.removeProperty("--textarea-height");
		}
	}, []);

	/**
	 * Handle sending or stopping based on current state.
	 */
	const handleSendOrStop = useCallback(async () => {
		if (isSending) {
			await onStopGeneration();
			return;
		}

		// #82 issue 3: a held queued message locks the composer — the Send
		// button must not fire the locked text (Edit/Delete are the actions).
		// (During streaming this is unreachable: isSending short-circuits above
		// to Stop, which stays live for cancel.)
		if (isQueuedSendBlocked({ isQueued, isSending })) return;

		// Allow sending if there's text OR attachments
		if (!inputValue.trim() && attachedFiles.length === 0) return;

		// Save input value and files before clearing
		const messageToSend = inputValue.trim();
		const filesToSend =
			attachedFiles.length > 0 ? [...attachedFiles] : undefined;

		// Clear input, files, and hint state immediately
		onInputChange("");
		onAttachedFilesChange([]);
		setHintText(null);
		setCommandText("");
		resetHistory();

		await onSendMessage(messageToSend, filesToSend);
	}, [
		isSending,
		isQueued,
		inputValue,
		attachedFiles,
		onSendMessage,
		onStopGeneration,
		onInputChange,
		onAttachedFilesChange,
		resetHistory,
	]);

	/**
	 * Handle dropdown keyboard navigation.
	 */
	/**
	 * The single open picker, with `select` bound to the composer-side
	 * selection effects (the hook owns navigation/dismiss; selection touches
	 * composer text, caret/focus, the slash hint overlay, and the quick-prompt
	 * engine fire — all InputArea concerns). Tier 2: this is what collapses the
	 * former 3-way handleDropdownKeyPress ladder into one routed object.
	 */
	const activePicker = useMemo<ActivePicker | null>(() => {
		if (!resolvedPicker) return null;
		return {
			...resolvedPicker,
			select: (evt) => {
				switch (resolvedPicker.kind) {
					case "quick-prompt":
						activateQuickPromptSelection(evt);
						break;
					case "slash": {
						const command =
							slashCommands.suggestions[
								slashCommands.selectedIndex
							];
						if (command) handleSelectSlashCommand(command);
						break;
					}
					case "mention": {
						const note =
							mentions.suggestions[mentions.selectedIndex];
						if (note) selectMention(note);
						break;
					}
				}
			},
		};
	}, [
		resolvedPicker,
		activateQuickPromptSelection,
		slashCommands,
		handleSelectSlashCommand,
		mentions,
		selectMention,
	]);

	/**
	 * Handle dropdown keyboard navigation. Routes every key through the single
	 * priority-resolved {@link ActivePicker} (Tier 2) instead of a 3-way
	 * per-source ladder; source-specific key rules read from `capabilities`.
	 */
	const handleDropdownKeyPress = useCallback(
		(e: React.KeyboardEvent): boolean => {
			if (!activePicker) {
				return false;
			}

			// Arrow navigation — each source owns its clamp-vs-wrap policy
			// (mention/slash clamp, quick-prompt wraps around its create row).
			if (e.key === "ArrowDown") {
				e.preventDefault();
				activePicker.navigate("down");
				return true;
			}

			if (e.key === "ArrowUp") {
				e.preventDefault();
				activePicker.navigate("up");
				return true;
			}

			// Shift+Enter dismisses WITHOUT selecting and WITHOUT inserting a
			// newline, for sources that declare it (mention only — matches
			// Obsidian's link-autocomplete convention, desktop v1.3.5+).
			// dismiss() also keeps the mention closed for this @ run. The slash
			// and quick-prompt pickers do not declare this, so their behavior is
			// unchanged. When no picker is open, the early return above lets
			// Shift+Enter fall through to the normal handler and insert a newline.
			if (
				e.key === "Enter" &&
				e.shiftKey &&
				!e.nativeEvent.isComposing &&
				activePicker.capabilities.dismissOnShiftEnter
			) {
				e.preventDefault();
				activePicker.dismiss();
				return true;
			}

			// Select item (Enter or Tab)
			if (e.key === "Enter" || e.key === "Tab") {
				// Skip Enter during IME composition (allow Tab to still work)
				if (e.key === "Enter" && e.nativeEvent.isComposing) {
					return false;
				}
				// QP-I14: the ⌥ / ⌘ / ⌘⌥ / ⌘⌥⇧ + Enter combos are owned by the
				// source's pushed Scope (it beats Obsidian’s editor link-open
				// hotkeys). If such a keydown also bubbles to React while that
				// source is open, swallow it here so we neither double-fire nor
				// fall through to the send path. Plain Enter and ⌘⇧Enter are not
				// scope-owned and proceed to select normally below.
				if (
					activePicker.capabilities.ownsEnterScopeCombos &&
					e.key === "Enter" &&
					isQuickPromptScopeCombo(e)
				) {
					e.preventDefault();
					return true;
				}
				e.preventDefault();
				activePicker.select(e);
				return true;
			}

			// Close dropdown (Escape). dismiss() for the mention keeps it closed
			// for this @ run so it does not immediately reopen on the next
			// keystroke (the query now allows spaces, so the run persists in the
			// text); slash/quick-prompt simply close.
			if (e.key === "Escape") {
				e.preventDefault();
				activePicker.dismiss();
				return true;
			}

			return false;
		},
		[activePicker],
	);

	// Button disabled state — single source of truth (deriveSendAffordance).
	// Files-attached counts as content; idle/connecting are sendable (I40/I41).
	const { buttonDisabled: isButtonDisabled } = deriveSendAffordance({
		lazyState,
		isSending,
		isQueued,
		hasContent: inputValue.trim() !== "" || attachedFiles.length > 0,
		isRestoringSession,
	});

	/**
	 * Handle keyboard events in the textarea.
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Handle dropdown navigation first
			if (handleDropdownKeyPress(e)) {
				return;
			}

			// Handle input history navigation (ArrowUp/ArrowDown)
			if (handleHistoryKeyDown(e, textareaRef.current)) {
				return;
			}

			// Normal input handling - check if should send based on shortcut setting
			const hasCmdCtrl = e.metaKey || e.ctrlKey;
			if (
				e.key === "Enter" &&
				(!e.nativeEvent.isComposing || hasCmdCtrl)
			) {
				const shouldSend =
					settings.sendMessageShortcut === "enter"
						? !e.shiftKey // Enter mode: send unless Shift is pressed
						: hasCmdCtrl; // Cmd+Enter mode: send only with Cmd/Ctrl

				if (shouldSend) {
					e.preventDefault();
					// #81: is this the (mode-aware) steer gesture? Both steer
					// combos carry the Mod key, so they always pass the
					// shouldSend gate above and reach here.
					const steerRequested = isSteerGesture({
						hasCmdCtrl,
						shiftKey: e.shiftKey,
						sendShortcut: settings.sendMessageShortcut,
					});
					const action = decideComposerEnterAction({
						isStreaming,
						isSessionReady,
						isButtonDisabled,
						isQueued,
						hasContent:
							inputValue.trim() !== "" ||
							attachedFiles.length > 0,
						steerRequested,
						launches,
					});
					if (action === "send") {
						void handleSendOrStop();
					} else if (action === "queue") {
						// Queue Next Message (#82): while the agent is
						// streaming, the send key queues the next message
						// instead of being a no-op. The composer text stays in
						// place (it becomes the locked queued message). The
						// toolbar button remains Stop so cancelling the live
						// turn stays reachable.
						onQueueMessage?.(inputValue.trim(), attachedFiles);
					} else if (action === "steer") {
						// Mid-Stream Steering (#81): the steer gesture while a
						// turn is streaming interrupts it and sends the composer
						// text as the next prompt. The composer text stays in
						// place (locked, showing the steering banner) until the
						// cancel settles and the redirect flushes.
						onSteerMessage?.(inputValue.trim(), attachedFiles);
					}
				}
				// If not shouldSend, allow default behavior (newline)
			}
		},
		[
			handleDropdownKeyPress,
			handleHistoryKeyDown,
			isSending,
			isButtonDisabled,
			handleSendOrStop,
			settings.sendMessageShortcut,
			isStreaming,
			isSessionReady,
			launches,
			isQueued,
			onQueueMessage,
			onSteerMessage,
			inputValue,
			attachedFiles,
		],
	);

	/**
	 * Handle input changes in the textarea.
	 */
	const handleInputChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const newValue = e.target.value;
			const cursorPosition = e.target.selectionStart || 0;

			onInputChange(newValue);

			// Hide hint overlay when user modifies the input
			if (hintText) {
				const expectedText = commandText + hintText;
				if (newValue !== expectedText) {
					setHintText(null);
					setCommandText("");
				}
			}

			// Update mention suggestions
			void mentions.updateSuggestions(newValue, cursorPosition);

			// Update slash command suggestions
			slashCommands.updateSuggestions(newValue, cursorPosition);

			// Update quick-prompt (! trigger) suggestions
			quickPrompts.updateSuggestions(newValue, cursorPosition);
		},
		[
			logger,
			hintText,
			commandText,
			mentions,
			slashCommands,
			quickPrompts,
			onInputChange,
		],
	);

	// Adjust textarea height when input changes. useLayoutEffect (pre-paint) so
	// the collapse lands in the SAME frame the text changes: with a post-paint
	// useEffect, clearing the composer on a !/@ pick painted one frame at the
	// stale (taller) height before collapsing — a visible flicker, worst in a
	// narrow pane where the trigger text had wrapped (QP-I19).
	useLayoutEffect(() => {
		adjustTextareaHeight();
	}, [inputValue, adjustTextareaHeight]);

	// Auto-focus textarea on mount; place the caret at the end so a restored
	// unsent draft (#94) is ready to keep typing instead of caret-at-start
	// (TP-I03). Empty composer → end === 0, unchanged.
	useEffect(() => {
		window.setTimeout(() => {
			focusComposerAtEnd(textareaRef.current);
		}, 0);
	}, []);

	// #82 issue 1: when a queued message is unlocked (Edit) or discarded
	// (Delete), return focus to the composer with the cursor at the end so the
	// user can keep typing immediately — without this, Edit unlocks the text
	// but leaves focus nowhere.
	const prevIsQueuedRef = useRef(isQueued);
	useEffect(() => {
		const wasQueued = prevIsQueuedRef.current;
		prevIsQueuedRef.current = isQueued;
		if (wasQueued && !isQueued) {
			window.setTimeout(() => {
				const el = textareaRef.current;
				if (!el) return;
				el.focus();
				const end = el.value.length;
				el.setSelectionRange(end, end);
			}, 0);
		}
	}, [isQueued]);

	// Focus textarea when this tab becomes active (I19)
	// Tabs are kept mounted and hidden via display:none; without this, hotkey-
	// driven tab switches leave focus on the previously active tab's textarea.
	useEffect(() => {
		if (isActive) {
			window.setTimeout(() => {
				if (textareaRef.current) {
					textareaRef.current.focus();
				}
			}, 0);
		}
	}, [isActive]);

	// Focus the composer when the tab's agent changes (agent switch / new chat
	// with a different agent) so the user can type immediately — without this,
	// switching via the header menu leaves focus on the menu, not the composer
	// (studio smoke (c), 2026-06-25). prevAgentIdRef gates to actual changes
	// (not mount, which the mount effect above already handles); isActive gates
	// out background tabs so a swap there can't steal focus.
	const prevAgentIdRef = useRef(agentId);
	useEffect(() => {
		const prev = prevAgentIdRef.current;
		prevAgentIdRef.current = agentId;
		if (prev !== agentId && isActive) {
			window.setTimeout(() => {
				focusComposerAtEnd(textareaRef.current);
			}, 0);
		}
	}, [agentId, isActive]);

	// Focus textarea when the ACP panel regains visibility from another
	// Obsidian pane. The isActive effect above only fires on tab switches
	// within ACP, not on leaf-level focus changes. (I26)
	const panelWasVisibleRef = useRef(true);
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				const visible = entry.isIntersecting;
				if (visible && !panelWasVisibleRef.current && isActive) {
					window.setTimeout(() => {
						textareaRef.current?.focus();
					}, 0);
				}
				panelWasVisibleRef.current = visible;
			},
			{ threshold: 0.1 },
		);
		observer.observe(textarea);
		return () => observer.disconnect();
	}, [isActive]);

	// Restore message when provided (e.g., after cancellation)
	// Only restore if input is empty to avoid overwriting user's new input
	useEffect(() => {
		if (restoredMessage) {
			if (!inputValue.trim()) {
				onInputChange(restoredMessage);
				// Focus and place cursor at end
				window.setTimeout(() => {
					if (textareaRef.current) {
						textareaRef.current.focus();
						textareaRef.current.selectionStart =
							restoredMessage.length;
						textareaRef.current.selectionEnd =
							restoredMessage.length;
					}
				}, 0);
			}
			onRestoredMessageConsumed();
		}
	}, [restoredMessage, onRestoredMessageConsumed, inputValue, onInputChange]);

	// Placeholder text — while streaming, teach BOTH keybindings (#82 queue +
	// #81 steer). The labels are mode-aware (so they never show the send key as
	// the steer key) and platform-labeled via utils/platform.ts (⌘ on macOS,
	// Ctrl elsewhere).
	const enterModeSend = settings.sendMessageShortcut === "enter";
	const queueKeyLabel = enterModeSend
		? ENTER_KEY
		: modCombo(MOD_KEY, ENTER_KEY);
	const steerKeyLabel = enterModeSend
		? modCombo(MOD_KEY, ENTER_KEY)
		: modCombo(MOD_KEY, SHIFT_KEY, ENTER_KEY);
	const placeholder = buildComposerPlaceholder({
		agentLabel,
		hasCommands: availableCommands.length > 0,
		hasQuickPrompts: hasQuickPrompts ?? false,
		isStreaming,
		isQueued,
		queueKeyLabel,
		steerKeyLabel,
	});

	return (
		<div className="agent-client-chat-input-container">
			{/* Error Overlay - displayed above input */}
			{errorInfo && (
				<ErrorBanner
					errorInfo={errorInfo}
					onClose={onClearError}
					showEmojis={showEmojis}
					view={view}
				/>
			)}

			{/* Agent Update Notification - hidden when error is showing */}
			{!errorInfo && agentUpdateNotification && (
				<ErrorBanner
					errorInfo={agentUpdateNotification}
					onClose={onClearAgentUpdate}
					showEmojis={showEmojis}
					view={view}
					variant={agentUpdateNotification.variant}
				/>
			)}

			{/* Mention Dropdown */}
			{mentions.isOpen && (
				<SuggestionPopup
					items={mentions.suggestions.map(noteToPickerItem)}
					instructions={mentionInstructions()}
					selectedIndex={mentions.selectedIndex}
					onSelect={(index) => {
						const note = mentions.suggestions[index];
						if (note) selectMention(note);
					}}
					onClose={mentions.close}
				/>
			)}

			{/* Slash Command Dropdown */}
			{slashCommands.isOpen && (
				<SuggestionPopup
					items={slashCommands.suggestions.map(
						slashCommandToPickerItem,
					)}
					instructions={slashInstructions()}
					selectedIndex={slashCommands.selectedIndex}
					onSelect={(index) => {
						const command = slashCommands.suggestions[index];
						if (command) handleSelectSlashCommand(command);
					}}
					onClose={slashCommands.close}
				/>
			)}

			{/* Quick Prompt (! trigger) Dropdown */}
			{quickPrompts.isOpen && (
				<SuggestionPopup
					items={quickPrompts.suggestions.map(
						quickPromptToPickerItem,
					)}
					instructions={quickPromptInstructions(
						quickPrompts.createRow != null &&
							quickPrompts.selectedIndex ===
								quickPrompts.suggestions.length,
					)}
					selectedIndex={quickPrompts.selectedIndex}
					onSelect={(index, evt) => {
						const prompt = quickPrompts.suggestions[index];
						if (prompt) selectQuickPrompt(prompt, evt);
					}}
					createRow={quickPrompts.createRow}
					onCreate={handleCreateQuickPrompt}
					onClose={quickPrompts.close}
				/>
			)}

			{/* Ephemeral contextual quick-prompt chips — directly above the box.
			    Renders nothing when no resting prompts match (S3). */}
			{quickPromptPrompts && (
				<QuickPromptBar
					prompts={quickPromptPrompts}
					hasPendingQueue={quickPromptHasPendingQueue ?? false}
					onFire={onRunQuickPrompt ?? (() => undefined)}
					onSearchAll={handleSearchAll}
					onChipContextMenu={(prompt, evt) =>
						plugin.showQuickPromptChipMenu(prompt, evt)
					}
				/>
			)}

			{/* Input Box - flexbox container with border */}
			<div
				className={`agent-client-chat-input-box ${isDraggingOver ? "agent-client-dragging-over" : ""} ${isQueued ? "agent-client-queued" : ""}`}
				role="presentation"
				onDragOver={handleDragOver}
				onDragEnter={handleDragEnter}
				onDragLeave={handleDragLeave}
				onDrop={(e) => void handleDrop(e)}
			>
				{/* Queued banner (#82). Not shown during a steer (#81): the
				    steer window is instant, so the transient "stopping…" banner
				    was imperceptible and confusing (I164) — the composer just
				    locks briefly with no banner, and the redirect sends. */}
				{isQueued && !isSteering && (
					<div
						className="agent-client-queued-banner"
						role="status"
						aria-live="polite"
					>
						<span
							className="agent-client-queued-banner-icon"
							aria-hidden="true"
							ref={(el) => {
								if (el) setIcon(el, "clock");
							}}
						/>
						<span className="agent-client-queued-banner-text">
							{buildQueuedBanner({
								agentLabel,
								isSessionReady,
								isAction: isQueuedAction,
							})}
						</span>
						<div className="agent-client-queued-banner-actions">
							{isQueuedAction ? (
								// A held ACTION is not composer text: Delete would
								// emit clearComposer and wipe an unrelated draft
								// (A2UI-I08). Offer only Cancel, which releases the
								// slot and leaves the composer untouched.
								<button
									type="button"
									className="agent-client-queued-edit"
									onClick={() => onEditQueued?.()}
								>
									{t("modals.common.cancel")}
								</button>
							) : (
								<>
									<button
										type="button"
										className="agent-client-queued-edit"
										onClick={() => onEditQueued?.()}
									>
										{t("chat.composer.edit")}
									</button>
									<button
										type="button"
										className="agent-client-queued-delete"
										onClick={() => onDeleteQueued?.()}
									>
										{t("chat.composer.delete")}
									</button>
								</>
							)}
						</div>
					</div>
				)}

				{/* Textarea with Hint Overlay */}
				<div className="agent-client-textarea-wrapper">
					<textarea
						ref={setComposerNode}
						value={inputValue}
						onChange={handleInputChange}
						onKeyDown={handleKeyDown}
						onPaste={(e) => void handlePaste(e)}
						placeholder={placeholder}
						className="agent-client-chat-input-textarea"
						rows={1}
						spellCheck={obsidianSpellcheck}
						readOnly={isQueued}
						aria-label={
							isQueued
								? t("chat.composer.queuedLocked")
								: undefined
						}
					/>
					{hintText && (
						<div
							className="agent-client-hint-overlay"
							aria-hidden="true"
						>
							<span className="agent-client-invisible">
								{commandText}
							</span>
							<span className="agent-client-hint-text">
								{hintText}
							</span>
						</div>
					)}
				</div>

				{/* Attachment Preview Strip (images + file references) */}
				<AttachmentStrip files={attachedFiles} onRemove={removeFile} />

				{/* Input Actions (Config Options / Mode Selector / Model Selector + Send Button) */}
				<InputToolbar
					isSending={isSending}
					isButtonDisabled={isButtonDisabled}
					hasContent={
						inputValue.trim() !== "" || attachedFiles.length > 0
					}
					onSendOrStop={() => void handleSendOrStop()}
					modes={modes}
					onModeChange={onModeChange}
					models={models}
					onModelChange={onModelChange}
					configOptions={configOptions}
					onConfigOptionChange={onConfigOptionChange}
					usage={usage}
					lazyState={lazyState}
				/>
			</div>
		</div>
	);
}
