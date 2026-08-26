import * as React from "react";
const { useState, useRef, useEffect, useMemo, useCallback } = React;
import {
	Notice,
	FileSystemAdapter,
	Platform,
	Menu,
	getAllTags,
	setIcon,
	type MenuItem,
} from "obsidian";

import { registerOpenMenu, showMenuAtEvent } from "../utils/menu-registry";
import { scheduleComposerRefocus } from "./composer-focus";
import { createSessionDispatchPort } from "../services/session-dispatch-port";
import {
	deriveLatestSurfaceId,
	deriveSurfaceAnswers,
	deriveSurfaceDefinitions,
	type A2uiSurfaceDefinitionSite,
} from "../services/a2ui/surface-state";
import { activateA2uiButton } from "../services/a2ui/activate";
import type { A2uiBubbleContext } from "./MessageBubble";
import type { AttachedFile, ChatInputState, ChatMessage } from "../types/chat";
import { isSameDirectory } from "../utils/platform";
import { usePillOpenScope } from "./use-pill-open-scope";
import {
	resolveDefaultWorkingDirectory,
	deriveCwdBanner,
} from "../utils/working-directory";
import {
	indexOfCurrentAgent,
	resolveCwdForAgent,
	resolveSessionIdForSave,
} from "../services/session-helpers";
import { deriveNewLeaf, shouldOpenFromActivation } from "../utils/link-leaf";
import {
	deriveSendAffordance,
	isSessionLive,
} from "../resolvers/send-affordance";
import { deriveTabState } from "../resolvers/tab-state";
import { extractLinks, type SharedLink } from "../utils/link-extract";
import {
	decideSessionIntent,
	selectAcquisitionAgent,
	type SessionIntent,
} from "../resolvers/agent-switch";
import { useHistoryModal } from "../hooks/useHistoryModal";
import { useComposerFocusReturn } from "../hooks/useComposerFocusReturn";
import { useChatActions } from "../hooks/useChatActions";
import { ChangeDirectoryModal } from "./ChangeDirectoryModal";
import { confirmSessionIntent } from "./ConfirmSessionIntentModal";
import { buildCarryOverBlocks } from "../services/carry-over-builder";
import {
	buildCarriedOverPreview,
	type CarriedOverPreview as CarriedOverPreviewData,
} from "../services/carried-over-preview";
import { CarriedOverPreview } from "./CarriedOverPreview";

// Service imports
import { getLogger } from "../utils/logger";
import {
	deriveTabLabel,
	labelAlreadyReportedOnMount,
	shouldReportInterimLabel,
} from "../resolvers/deriveTabLabel";
import { buildCompletionNotificationContent } from "../utils/notification-content";
import { runNotificationClick } from "../utils/notification-click";
import { shouldNotifySystem } from "../resolvers/notify-gate";
import { retainNotification } from "../utils/notification-registry";
import { decideGrabToggle } from "../utils/activeNoteGrabToggle";
import { useRestoredMessages } from "../hooks/useRestoredMessages";
import { loadExistingSessionFlow } from "../hooks/loadExistingSessionFlow";

// Adapter imports
import type { AcpClient } from "../acp/acp-client";

// Context imports
import { useChatContext } from "./ChatContext";

// Hooks imports
import { useSettings } from "../hooks/useSettings";
import { useSuggestions } from "../hooks/useSuggestions";
import { useContextNotes } from "../hooks/useContextNotes";
import type { ContextNote } from "../types/context";
import { useSelectionTracker } from "../hooks/useSelectionTracker";
import {
	useContextVaultEvents,
	type VaultEventSource,
} from "../hooks/useContextVaultEvents";
import { useAgent } from "../hooks/useAgent";
import { useSessionHistory } from "../hooks/useSessionHistory";
import { useLazySession } from "../hooks/useLazySession";
import { useDebouncedSessionSave } from "../hooks/useDebouncedSessionSave";
import {
	useQueueOrchestration,
	type QueueEffectHandlers,
} from "../hooks/useQueueOrchestration";
import {
	decideConnectFlush,
	decideQueuedSendKind,
} from "../services/message-queue-logic";
import {
	useQuickPrompts,
	type QuickPromptComposerBridge,
} from "../hooks/useQuickPrompts";
import type { QuickPrompt } from "../types/quick-prompt";
import type { QuickPromptGesture } from "../services/quick-prompts-logic";
import {
	deriveLabelFromComposer,
	matchPromptsForNote,
} from "../services/quick-prompts-logic";

// Domain model imports
import {
	flattenConfigSelectOptions,
	type SlashCommand,
	type SessionModeState,
	type SessionModelState,
	type SessionConfigOption,
} from "../types/session";
import { checkAgentUpdate } from "../services/update-checker";

/** Stable empty array for useSuggestions when no commands available */
const EMPTY_COMMANDS: SlashCommand[] = [];

// Component imports
import { ChatHeader } from "./ChatHeader";
import { MessageList, type GettingStartedInfo } from "./MessageList";
import { shouldShowGettingStarted } from "../services/agent-detection";
import { installAgent } from "../services/agent-installer";
import { InputArea } from "./InputArea";
import { ContextStrip } from "./ContextStrip";
import { focusComposerAtEnd, sendAndReturnFocus } from "./composer-focus";
import { createQuickPromptBridge } from "./quick-prompt-bridge";
import { computeProvisionalPath } from "../utils/provisional-context";
import {
	deriveComposerAffordances,
	composerCapabilitiesFromSession,
} from "../resolvers/composer-affordances";
import type { IChatViewHost } from "./view-host";
import { t } from "../i18n";

// ============================================================================
// ChatPanelCallbacks - interface for class-level delegation
// ============================================================================

/**
 * Callbacks that ChatPanel registers with its parent container class.
 * Used by ChatView to implement IChatViewContainer
 * by delegating to the React component's state and handlers.
 */
export interface ChatPanelCallbacks {
	getDisplayName: () => string;
	getInputState: () => ChatInputState | null;
	setInputState: (state: ChatInputState) => void;
	canSend: () => boolean;
	sendMessage: () => Promise<boolean>;
	cancelOperation: () => Promise<void>;
	/** True when this tab holds a pending queued message (#82 broadcast skip-guard). */
	hasPendingQueue: () => boolean;
	/** Fire / insert a quick prompt in this tab (chips / composer ! trigger). */
	runQuickPrompt: (prompt: QuickPrompt, gesture: QuickPromptGesture) => void;
	/** Focus this tab's composer and start a ! quick-prompt search. */
	startQuickPromptSearch: () => void;
	/** Save the current composer draft as a new quick-prompt note. */
	saveComposerAsQuickPrompt: () => void;
	/** Current resolved working directory for this tab (persisted for restore). */
	getWorkingDirectory: () => string;
	/** Open the Session History modal for this tab (open-session-history command). */
	openHistory: () => void;
	/**
	 * Await any pending session-message write to disk (I193). Called by
	 * ChatView.onClose before unmount so the final turn survives quit/reload,
	 * mirroring the tab-state flushSave.
	 */
	flushSessionSave: () => Promise<void>;
}

// ============================================================================
// ChatPanelProps
// ============================================================================

export interface ChatPanelProps {
	viewId: string;
	/** Runtime acquisition provenance supplied synchronously before mount. */
	tabOrigin: import("../types/tab").TabOrigin;
	workingDirectory?: string;
	initialAgentId?: string;
	config?: { agent?: string; model?: string };
	onRegisterCallbacks?: (callbacks: ChatPanelCallbacks) => void;
	/** Called when agent ID changes (sidebar only — persists in Obsidian state) */
	onAgentIdChanged?: (agentId: string) => void;
	/** Obsidian view host for DOM event registration */
	viewHost: IChatViewHost;
	/** Called when session state changes (for tab icon updates) */
	onStateChange?: (state: import("../types/tab").TabState) => void;
	/** Called when a suitable tab label is available (session title or first message) */
	onLabelChange?: (label: string) => void;
	/** Called when the session ID changes (for tab rename persistence) */
	onSessionIdChange?: (sessionId: string | null) => void;
	/** Whether this tab is the currently active tab (controls focus on activation) */
	isActive?: boolean;
	/**
	 * Human-readable label of the tab hosting this panel (AI-suggested title,
	 * custom rename, or first-message derivation). Surfaced as the completion
	 * notification title so a multi-tab user sees WHICH tab finished. Undefined
	 * for a floating chat (no tab) — the notification falls back to the plugin name.
	 */
	tabLabel?: string;
	/** Look up whether a session is already open in another tab (I20) */
	findTabBySessionId?: (
		sessionId: string,
	) => { tabId: string; label: string } | null;
	/** Switch to a specific tab by ID (I20) */
	onSwitchToTab?: (tabId: string) => void;
	/** Close a specific tab by ID (used when its session is deleted) */
	onCloseTab?: (tabId: string) => void;
	/**
	 * Open a history session in a matched-or-new tab (Track C). Restore/fork
	 * route through here (ChatView orchestration) instead of restoring into the
	 * current tab, so the active session is never clobbered.
	 */
	onOpenSessionInTab?: (
		sessionId: string,
		cwd: string,
		mode: "restore" | "fork",
	) => void | Promise<void>;
	/** Apply a custom (user-explicit) label to a tab by ID (I128 — history rename) */
	onSetTabLabelCustom?: (tabId: string, label: string) => void;
	/** Persisted session ID for this tab (from tab persistence). Passed to useLazySession for session/load on first keystroke. */
	restoredSessionId?: string | null;
	/**
	 * Session to fork from on first acquisition (Track C). Set on a tab opened
	 * via Session History "fork": the first send branches a NEW session from
	 * this id (connect-then-fork) while the seeded transcript displays.
	 */
	restoredForkSessionId?: string | null;
	/**
	 * Explicit, collision-suffixed "Fork: …" title for a fork tab (Track C).
	 * Recorded as the branch's history title via the single writer so it is
	 * set on create and preserved across later turn-end saves.
	 */
	restoredForkTitle?: string;
	/** Restored message history for this tab (from tab persistence). Seeded into the message list on async arrival while idle (I43). */
	restoredMessages?: ChatMessage[];
	/** Restored context notes for this tab (from tab persistence). Rehydrates the context strip on async arrival while idle (I61). */
	restoredContextNotes?: ContextNote[];
	/**
	 * True when this restored tab has a persisted sessionId but no local
	 * message file (I72). Drives the "history not stored locally — reload
	 * from agent" affordance so the tab shows a recoverable state instead of
	 * a silent blank panel.
	 */
	historyRecoverable?: boolean;
	/**
	 * Restored unsent draft text for this tab (from tab persistence). Seeds the
	 * composer's initial value at mount so a half-typed prompt survives panel
	 * close/reopen and restart. Undefined / "" means no draft.
	 * See [[ACP Preserve Unsent Draft Text Per Tab]].
	 */
	restoredDraft?: string;
	/**
	 * Called (after mount) whenever the composer's text changes, so the parent
	 * can debounce-persist the draft. Fires on user typing and on send-clear;
	 * not on the initial restore-seed. (Draft persistence — restart fix.)
	 */
	onDraftChange?: () => void;
	/**
	 * Open a fresh tab/session for a `newTab` quick prompt. ChatView owns the
	 * tab manager, so a fire in the active tab routes up here to spawn a
	 * sibling tab and dispatch the resolved prompt into it. See [[Agent Console
	 * Quick Prompts and Workflows]] § Fire target.
	 */
	onOpenInNewTab?: (
		text: string,
		opts: { send: boolean; foreground: boolean },
	) => void;
	/**
	 * One-shot seed for a tab just spawned by a `newTab` quick prompt:
	 * `send: true` dispatches `text` through the lazy-acquisition send path
	 * (queues until the fresh session connects, I69); `send: false` only seeds
	 * the composer for the user to edit. Consumed once on mount.
	 */
	initialPrompt?: { text: string; send: boolean };
}

// ============================================================================
// State Definitions
// ============================================================================

// Type definitions for Obsidian internal APIs (sidebar menu)
interface AppWithSettings {
	setting: {
		open: () => void;
		openTabById: (id: string) => void;
	};
}

// ============================================================================
// ChatPanel Component
// ============================================================================

/**
 * Core chat panel component that encapsulates all chat logic.
 *
 * This is the single source of truth for chat state and behavior,
 * for the sidebar chat view. It is a 1:1 migration of useChatController
 * into a React component.
 */
/**
 * Raise the Obsidian window that owns this renderer to the OS foreground.
 *
 * Used by the system-notification onclick handlers (I52). DOM `window.focus()`
 * is a no-op for cross-window foregrounding in Electron
 * (electron/electron#25578), so a click landed on the most-recently-active
 * window — the wrong vault in a multi-vault setup. The native
 * `BrowserWindow.focus()` does raise the window, and `remote.getCurrentWindow()`
 * returns the window owning this renderer. Obsidian exposes no public API to
 * foreground an OS window, so we use the Electron `remote` bridge — the same
 * runtime-require pattern as ChangeDirectoryModal.
 */
function focusOwningWindow(): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- electron is a runtime-only module provided by Obsidian's host environment
		const { remote } = require("electron") as {
			remote: { getCurrentWindow: () => { focus: () => void } };
		};
		remote.getCurrentWindow().focus();
	} catch {
		// Non-Electron host (e.g. mobile) — best-effort DOM focus.
		window.focus();
	}
}

export function ChatPanel({
	viewId,
	tabOrigin,
	workingDirectory,
	initialAgentId,
	config,
	onRegisterCallbacks,
	onAgentIdChanged,
	viewHost,
	onStateChange,
	onLabelChange,
	onSessionIdChange,
	isActive,
	tabLabel,
	findTabBySessionId,
	onSwitchToTab,
	onCloseTab,
	onOpenSessionInTab,
	onSetTabLabelCustom,
	restoredSessionId,
	restoredForkSessionId,
	restoredForkTitle,
	restoredMessages,
	restoredContextNotes,
	historyRecoverable,
	restoredDraft,
	onDraftChange,
	onOpenInNewTab,
	initialPrompt,
}: ChatPanelProps) {
	// ============================================================
	// Platform Check
	// ============================================================
	if (!Platform.isDesktopApp) {
		throw new Error("Agent Client is only available on desktop");
	}

	// ============================================================
	// Context
	// ============================================================
	const { plugin, acpClient, vaultService } = useChatContext();

	// ============================================================
	// Memoized Services & Adapters
	// ============================================================
	const logger = getLogger();

	// Vault root (true base path) — the final fallback for all cwd resolution
	// and the reference for the "different directory" banner / launch toast.
	const vaultRoot = useMemo(() => {
		const adapter = plugin.app.vault.adapter;
		return adapter instanceof FileSystemAdapter
			? adapter.getBasePath()
			: process.cwd(); // Fallback for non-FileSystemAdapter (e.g., mobile)
	}, [plugin]);

	// Global-default baseline, used as the banner reference. Blank → vault root;
	// invalid → vault root. (Transparency Notice is fired once in the effect below.)
	const vaultPath = useMemo(() => {
		if (workingDirectory) {
			return workingDirectory;
		}
		return resolveDefaultWorkingDirectory(
			plugin.settings.defaultWorkingDirectory,
			vaultRoot,
		).dir;
	}, [plugin, workingDirectory, vaultRoot]);

	// Launch directory for THIS chat's agent: per-agent default → global default
	// → vault root. Only brand-new chats resolve from the agent; restored/forked
	// sessions keep their persisted cwd (workingDirectory).
	const initialCwdResolution = useMemo(() => {
		if (workingDirectory) {
			return {
				dir: workingDirectory,
				source: "agent" as const,
				fellBack: false,
			};
		}
		return resolveCwdForAgent(
			plugin.settings,
			initialAgentId ?? plugin.settings.defaultAgentId,
			vaultRoot,
		);
	}, [plugin, workingDirectory, initialAgentId, vaultRoot]);

	// Agent working directory — initialized to the resolved per-agent default.
	// Can be changed via "New chat in directory..." (setAgentCwd).
	const [agentCwd, setAgentCwd] = useState(initialCwdResolution.dir);

	// One-time launch transparency. For a brand-new chat: warn if a configured
	// directory was invalid, otherwise announce when the chat starts outside the
	// vault root. Restored sessions stay silent — the banner already shows their cwd.
	const cwdLaunchNoticed = useRef(false);
	useEffect(() => {
		if (cwdLaunchNoticed.current || workingDirectory) {
			return;
		}
		cwdLaunchNoticed.current = true;
		const { dir, fellBack } = initialCwdResolution;
		if (fellBack) {
			new Notice(
				t("notices.invalidWorkingDirectory", { dir }),
			);
		} else if (!isSameDirectory(dir, vaultRoot)) {
			new Notice(t("notices.newChatStartedIn", { dir }));
		}
	}, []);

	// ============================================================
	// Custom Hooks
	// ============================================================
	const settings = useSettings(plugin);

	const agent = useAgent(
		acpClient,
		plugin.settingsService,
		vaultService,
		agentCwd,
		initialAgentId,
	);

	const {
		session,
		isReady: isSessionReady,
		messages,
		isSending,
		errorInfo,
	} = agent;

	const suggestions = useSuggestions(
		vaultService,
		plugin,
		session.availableCommands || EMPTY_COMMANDS,
		settings.activeNoteAsDefaultContext,
		plugin.quickPromptLibrary,
	);

	// ============================================================
	// Context Note Lifecycle (crystallized notes + selection)
	// ============================================================
	const contextNotes = useContextNotes();
	const selectionTracker = useSelectionTracker(vaultService);

	const vaultEventSource = useMemo<VaultEventSource>(
		() => ({
			onRename: (cb) => {
				const ref = plugin.app.vault.on("rename", (file, oldPath) =>
					cb(oldPath, file.path),
				);
				return () => plugin.app.vault.offref(ref);
			},
			onDelete: (cb) => {
				const ref = plugin.app.vault.on("delete", (file) =>
					cb(file.path),
				);
				return () => plugin.app.vault.offref(ref);
			},
		}),
		[plugin.app.vault],
	);

	const crystallizedPaths = useMemo(
		() => new Set(contextNotes.notes.map((n) => n.path)),
		[contextNotes.notes],
	);

	// Auto-default provisional suppress (Decision #26, I68): `×` on the
	// provisional pill sets this sticky flag so it won't re-arm for this tab.
	const [autoDefaultSuppressed, setAutoDefaultSuppressed] = useState(false);

	useContextVaultEvents({
		vault: vaultEventSource,
		crystallizedPaths,
		onRename: contextNotes.rename,
		onRemove: (path) => {
			contextNotes.remove(path);
			const name = (path.split("/").pop() ?? path).replace(/\.md$/, "");
			new Notice(
				t("notices.contextNoteDeleted", { name }),
			);
		},
	});

	const selectionForSend = useMemo(
		() =>
			selectionTracker.activeNotePath && selectionTracker.selection
				? {
						path: selectionTracker.activeNotePath,
						fromLine: selectionTracker.selection.fromLine,
						toLine: selectionTracker.selection.toLine,
					}
				: null,
		[selectionTracker.activeNotePath, selectionTracker.selection],
	);

	// Session history hook with callback for session load
	const handleSessionLoad = useCallback(
		(
			sessionId: string,
			modes?: SessionModeState,
			models?: SessionModelState,
			configOptions?: SessionConfigOption[],
		) => {
			logger.log(
				`[ChatPanel] Session loaded/resumed/forked: ${sessionId}`,
				{
					modes,
					models,
					configOptions,
				},
			);
			void agent.updateSessionFromLoad(
				sessionId,
				modes,
				models,
				configOptions,
			);
		},
		[logger, agent.updateSessionFromLoad],
	);

	const sessionHistory = useSessionHistory({
		agentClient: acpClient,
		session,
		settingsAccess: plugin.settingsService,
		cwd: vaultPath,
		agentCwd,
		onSessionLoad: handleSessionLoad,
		onMessagesRestore: agent.setMessagesFromLocal,
		onIgnoreUpdates: agent.setIgnoreUpdates,
		onClearMessages: agent.clearMessages,
		onContextNotesRestore: contextNotes.replace,
	});

	// Seed restored history into the message list when the async disk read
	// resolves, but only while idle (no live session) so it never clobbers
	// an active conversation (I43, spec Decision #12).
	useRestoredMessages({
		restoredMessages,
		restoredContextNotes,
		hasSession: !!session.sessionId,
		apply: agent.setMessagesFromLocal,
		applyContextNotes: contextNotes.replace,
	});

	// ============================================================
	// Local State
	// ============================================================
	const [isUpdateAvailable, setIsUpdateAvailable] = useState(false);

	// Cross-agent carry-over preview shown at the top of a freshly-switched
	// tab until the first real message lands. See [[Agent-Portable Sessions]].
	const [carriedOver, setCarriedOver] =
		useState<CarriedOverPreviewData | null>(null);

	// Input state (for broadcast commands). Seeded from the restored draft so a
	// half-typed prompt survives panel close/reopen and restart (initializer
	// runs once at mount; later draft changes never re-seed, so live typing is
	// never clobbered). See [[ACP Preserve Unsent Draft Text Per Tab]].
	const [inputValue, setInputValue] = useState(restoredDraft ?? "");
	const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);

	// Notify the parent (which debounces) whenever the composer text changes,
	// so the draft is persisted shortly after typing. The active tab's draft
	// has no other reliable save trigger before quit/restart. Skip the initial
	// mount so the restore-seed doesn't spuriously trigger a save.
	const onDraftChangeRef = useRef(onDraftChange);
	onDraftChangeRef.current = onDraftChange;
	const draftChangeMountedRef = useRef(false);
	useEffect(() => {
		if (!draftChangeMountedRef.current) {
			draftChangeMountedRef.current = true;
			return;
		}
		onDraftChangeRef.current?.();
	}, [inputValue]);

	// ============================================================
	// Refs
	// ============================================================
	const terminalClientRef = useRef<AcpClient>(acpClient);

	// ============================================================
	// Computed Values
	// ============================================================
	const activeAgentLabel = useMemo(() => {
		const activeId = session.agentId;
		if (activeId === plugin.settings.claude.id) {
			return (
				plugin.settings.claude.displayName || plugin.settings.claude.id
			);
		}
		if (activeId === plugin.settings.codex.id) {
			return (
				plugin.settings.codex.displayName || plugin.settings.codex.id
			);
		}
		if (activeId === plugin.settings.gemini.id) {
			return (
				plugin.settings.gemini.displayName || plugin.settings.gemini.id
			);
		}
		if (activeId === plugin.settings.kiro.id) {
			return plugin.settings.kiro.displayName || plugin.settings.kiro.id;
		}
		const custom = plugin.settings.customAgents.find(
			(agent) => agent.id === activeId,
		);
		return custom?.displayName || custom?.id || activeId;
	}, [session.agentId, plugin.settings]);

	/**
	 * Header branding segments — see Agent Console Header Branding spec.
	 *
	 * Layered as: Plugin → Profile → Runtime → Model.
	 * - plugin: client-sourced (manifest), shown in literal brackets
	 * - profile: client-sourced (settings.displayName), the "which configuration" signal
	 * - runtime: ACP-sourced (session.agentInfo), null while connecting
	 * - model:   ACP-sourced (session.models), null while connecting
	 *
	 * Both ACP segments null = "Connecting…" placeholder rendered by ChatHeader.
	 */
	const headerSegments = useMemo(() => {
		const pluginName = plugin.manifest.name;
		const profile = activeAgentLabel;

		const info = session.agentInfo;
		const runtime = info
			? `${info.title || info.name}${info.version ? ` ${info.version}` : ""}`
			: null;

		// Prefer confirmedModelId (from response metadata, SDK 0.24+),
		// fall back to legacy models state for older agents.
		const models = session.models;
		const legacyModel = models?.availableModels.find(
			(m) => m.modelId === models.currentModelId,
		)?.name;
		const model = session.confirmedModelId ?? legacyModel ?? null;

		return { plugin: pluginName, profile, runtime, model };
	}, [
		plugin.manifest.name,
		activeAgentLabel,
		session.agentInfo,
		session.models,
		session.confirmedModelId,
	]);

	const availableAgents = useMemo(() => {
		return plugin.getAvailableAgents();
	}, [plugin]);

	// ============================================================
	// Chat Actions
	// ============================================================
	// Forward ref to useLazySession.acquireNow (created later). restart-agent
	// and hard-reload route their re-acquisition through the single owner.
	const lazyAcquireNowRef = useRef<(() => Promise<void>) | null>(null);
	const actions = useChatActions(
		plugin,
		agent,
		sessionHistory,
		suggestions,
		session,
		messages,
		settings,
		vaultPath,
		contextNotes,
		selectionForSend,
		selectionTracker.activeNotePath,
		autoDefaultSuppressed,
		lazyAcquireNowRef,
		vaultRoot,
		agentCwd,
	);

	const {
		handleSendMessage,
		handleStopGeneration,
		handleExportChat,
		handleReload,
		isReloading,
		handleSetMode,
		handleSetModel,
		handleSetConfigOption,
		handleClearError,
		handleClearAgentUpdate,
		handleRestoredMessageConsumed,
		restoredMessage,
		agentUpdateNotification,
		setAgentUpdateNotification,
		autoExportIfEnabled,
		setCarryOverBlocks,
	} = actions;

	// Focus-return after in-panel state changes — [[Composer Focus Return After State Change]].
	const { composerElRef, focusAfter } = useComposerFocusReturn();

	// Open a context-pill note, honoring left/middle-click, Enter, and the
	// ⌘/⌃/⌥/⇧ pane modifiers. Button-based gate so keyboard activation (no
	// `.button`) isn't swallowed (I148); pane derived via the sanctioned
	// Keymap.isModEvent. Shared by onPillClick and the Mod/Alt+Enter scope below.
	const openContextNote = useCallback(
		(path: string, native: MouseEvent | KeyboardEvent) => {
			if (!shouldOpenFromActivation(native)) return;
			void plugin.app.workspace.openLinkText(
				path,
				plugin.app.workspace.getActiveFile()?.path ?? "",
				deriveNewLeaf(native),
			);
		},
		[plugin.app.workspace],
	);

	const handleContextPillClick = useCallback(
		(path: string, event: React.MouseEvent | React.KeyboardEvent) =>
			openContextNote(path, event.nativeEvent),
		[openContextNote],
	);

	// Open the focused context pill on the ⌥/⌘/⌃/⇧+Enter combos. Gated on
	// isActive so only the active tab's mounted panel pushes the scope (I156);
	// scope parents to the view scope so unhandled keys fall through (I155).
	usePillOpenScope(plugin, viewHost, isActive ?? false, openContextNote);

	// Shared Links Bubble: derive the per-tab link set from the active tab's
	// messages (spec [[Shared Links Bubble]] § "derive, don't store").
	// Resolve internal links against the vault so illustrative/abbreviated
	// wikilinks the agent typed in prose (e.g. [[file]]) are excluded (SLB-I8);
	// external URLs are unaffected.
	const resolveInternalLink = useCallback(
		(linkpath: string): boolean =>
			plugin.app.metadataCache.getFirstLinkpathDest(linkpath, "") !==
			null,
		[plugin.app.metadataCache],
	);
	const sharedLinks = useMemo(
		() => extractLinks(messages, { resolveInternal: resolveInternalLink }),
		[messages, resolveInternalLink],
	);

	const handleOpenSharedLink = useCallback(
		(link: SharedLink, evt: MouseEvent | KeyboardEvent) => {
			if (link.kind === "external") {
				window.open(link.target, "_blank");
				return;
			}
			// Internal vault file — honor open-in-new-tab modifiers via the
			// same sanctioned resolver the chat-panel links use.
			const newLeaf =
				evt instanceof MouseEvent ? deriveNewLeaf(evt) : false;
			void plugin.app.workspace.openLinkText(
				link.target,
				plugin.app.workspace.getActiveFile()?.path ?? "",
				newLeaf,
			);
		},
		[plugin.app.workspace],
	);

	// Track whether tab label has been reported (reset on new chat / restore).
	// TS-I03: a restored tab (one with a persisted/restored sessionId) starts
	// with the label already "reported" so the interim first-message effect
	// does not re-derive and clobber the persisted label (e.g. an AI title)
	// with the replayed first-message text.
	const labelReportedRef = useRef(
		labelAlreadyReportedOnMount(restoredSessionId),
	);

	// Forward ref to useLazySession.reset — handleNewChatWithPersist (declared
	// above the lazySession hook) drives the lazy machine back to idle on a
	// recreate-lazy/swap-idle intent. Assigned right after useLazySession runs.
	const lazyResetRef = useRef<(() => void) | null>(null);
	// New-chat-in-directory sets this before eager acquisition so the existing
	// createSession override is used even before agentCwd re-renders.
	const acquisitionCwdOverrideRef = useRef<string | null>(null);

	// Stable refs for tab callbacks (avoid re-render loops from inline arrow props)
	const onStateChangeRef = useRef(onStateChange);
	onStateChangeRef.current = onStateChange;
	const onLabelChangeRef = useRef(onLabelChange);
	onLabelChangeRef.current = onLabelChange;

	const handleLabelChangeFromRestore = useCallback((label: string) => {
		onLabelChangeRef.current?.(label);
		labelReportedRef.current = true;
	}, []);

	const { handleOpenHistory } = useHistoryModal(
		plugin,
		agent,
		sessionHistory,
		vaultPath,
		isSessionReady,
		settings.debugMode,
		setAgentCwd,
		handleLabelChangeFromRestore,
		session.sessionId ?? undefined,
		findTabBySessionId,
		onSwitchToTab,
		onCloseTab,
		onOpenSessionInTab,
		onSetTabLabelCustom,
	);

	// Stable ref so the registered callback bundle doesn't churn on
	// handleOpenHistory identity changes (mirrors handleSendMessageRef etc.).
	const handleOpenHistoryRef = useRef(handleOpenHistory);
	handleOpenHistoryRef.current = handleOpenHistory;

	// ============================================================
	// Sidebar-specific: agent switch / new-chat dispatcher.
	// ============================================================
	// Intent dispatcher for switch-agent / new-chat against the CURRENT tab
	// ([[Tab Agent Identity and Session Acquisition Unification]] design #1).
	// No path here calls agent.createSession directly. Agent switching resets
	// and remains lazy; deliberate New chat resets and asks useLazySession to
	// acquire immediately. Both converge on the same owner, preventing the I53
	// duplicate-session race.
	const handleNewChatWithPersist = useCallback(
		async (requestedAgentId?: string) => {
			try {
				const decision = decideSessionIntent({
					intent: (requestedAgentId
						? "switch-agent"
						: "new-chat") satisfies SessionIntent,
					currentAgentId: session.agentId,
					requestedAgentId,
					hasSession: !!session.sessionId,
					messageCount: messages.length,
				});

				if (decision.kind === "noop") return;

				// This dispatcher only issues switch-agent / new-chat intents,
				// which resolve to swap-idle or recreate-lazy. respawn-lazy and
				// resume come from restart/reload (Slice 3), never here — guard
				// so the decision.agentId access below is type-safe.
				if (
					decision.kind !== "swap-idle" &&
					decision.kind !== "recreate-lazy" &&
					decision.kind !== "recreate-eager"
				) {
					return;
				}

				// recreate-lazy: genuine teardown of an existing
				// session/transcript before rebinding (auto-export first).
				let carriedMessages: typeof messages | null = null;
				let carriedFromAgent = "";
				if (
					decision.kind === "recreate-lazy" ||
					decision.kind === "recreate-eager"
				) {
					// --- No silent data loss guard (Track 2) ---
					if (messages.length > 0) {
						const isSwitch = decision.agentId !== session.agentId;
						const kind = isSwitch ? "switch-agent" : "new-chat";

						// Optimistically set carry-over blocks BEFORE the
						// modal opens — the user may type and send while
						// the modal is visible, and that send must carry the
						// context. Cleared on cancel.
						// Always use XML text blocks (not resource blocks)
						// because we don't know the TARGET agent's capabilities
						// yet — it hasn't connected. XML works universally.
						if (isSwitch) {
							const blocks = buildCarryOverBlocks(
								messages,
								false, // always XML — target agent unknown
							);
							setCarryOverBlocks(blocks);
							carriedMessages = [...messages];
							carriedFromAgent = activeAgentLabel;
						}

						const agentName = isSwitch
							? agent
									.getAvailableAgents()
									.find((a) => a.id === decision.agentId)
									?.displayName || decision.agentId
							: undefined;
						const confirmResult = await confirmSessionIntent(
							plugin.app,
							{
								kind: kind,
								canCarryOver: isSwitch,
							},
							agentName,
						);
						if (confirmResult === "cancel") {
							// Clear optimistic carry-over on cancel
							setCarryOverBlocks(null);
							return;
						}
					}

					if (agent.isSending) {
						await agent.cancelOperation();
					}
					if (messages.length > 0) {
						await autoExportIfEnabled("newChat", messages, session);
					}
					suggestions.mentions.toggleAutoMention(false);
					agent.clearMessages();
					sessionHistory.invalidateCache();
				}

				// Rebind without creating a session directly. Lazy decisions reset
				// to idle; eager decisions call useLazySession.acquireNow(). Both
				// acquire against decision.agentId,
				// the now-current source of truth (session.agentId).
				// I131: on a real agent switch, re-resolve the working directory
				// for the NEW agent first, so the lazy acquisition launches in
				// that agent's configured cwd (per-agent default → global →
				// vault root) instead of the previous agent's. Mirrors the
				// setAgentCwd call in handleNewChatInDirectory; gated to a real
				// switch so a plain new-chat on the same agent keeps any
				// user-set cwd.
				if (requestedAgentId && requestedAgentId !== session.agentId) {
					setAgentCwd(
						resolveCwdForAgent(
							plugin.settings,
							decision.agentId,
							vaultRoot,
						).dir,
					);
				}
				agent.setAgentWithoutSession(decision.agentId);
				if (decision.kind === "recreate-eager") {
					void lazyAcquireNowRef.current?.();
				} else {
					lazyResetRef.current?.();
				}
				labelReportedRef.current = false;
				onLabelChangeRef.current?.("");
				// Persist agent ID for this view (survives Obsidian restart).
				onAgentIdChanged?.(decision.agentId);

				// After rebind + lazy reset, re-populate the chat view with
				// the carried-over messages so the user sees exactly what
				// the new agent will receive as context. Must be AFTER the
				// lazy reset so the message population doesn't trigger an
				// eager send on the old session.
				if (carriedMessages && carriedMessages.length > 0) {
					// Show the carried-over conversation as a distinct read-only
					// block (NOT real messages, so first-message semantics are
					// preserved). It persists for the session (user-collapsible)
					// and is delivered to the new agent on the first send.
					setCarriedOver(
						buildCarriedOverPreview(
							carriedMessages,
							carriedFromAgent,
						),
					);
				} else {
					// New chat / switch with nothing to carry — drop any stale
					// preview left from a prior switch on this tab.
					setCarriedOver(null);
				}

				// I166: new chat is composer-terminal; the user types next, so
				// return focus to the composer.
				focusAfter("new-chat");
			} catch (error) {
				console.error("[Agent Console] New chat error:", error);
			}
		},
		[
			session,
			session.agentId,
			session.sessionId,
			messages,
			agent.isSending,
			agent.cancelOperation,
			agent.clearMessages,
			agent.setAgentWithoutSession,
			agent.getAvailableAgents,
			agent.setMessagesFromLocal,
			autoExportIfEnabled,
			suggestions.mentions.toggleAutoMention,
			sessionHistory.invalidateCache,
			onAgentIdChanged,
			setAgentCwd,
			plugin,
			vaultRoot,
			setCarryOverBlocks,
			session.promptCapabilities,
			activeAgentLabel,
			focusAfter,
		],
	);

	// ============================================================
	// Sidebar-specific: Header Menu (Obsidian native Menu API)
	// ============================================================
	const handleOpenSettings = useCallback(() => {
		const appWithSettings = plugin.app as unknown as AppWithSettings;
		appWithSettings.setting.open();
		appWithSettings.setting.openTabById(plugin.manifest.id);
	}, [plugin]);

	// Deep-link into Obsidian's own updater (Settings → Community plugins) when
	// the "update available" pill is clicked. We hand off to the sanctioned
	// updater rather than self-updating — see the `Agent Console Update Pill
	// Click-Through` spec. The "community-plugins" core tab id was verified
	// against the running Obsidian (app.setting.settingTabs).
	const handleOpenCommunityPlugins = useCallback(() => {
		const appWithSettings = plugin.app as unknown as AppWithSettings;
		appWithSettings.setting.open();
		appWithSettings.setting.openTabById("community-plugins");
	}, [plugin]);

	const handleNewChatInDirectory = useCallback(
		async (directory: string) => {
			try {
				const decision = decideSessionIntent({
					intent: "new-chat-in-directory",
					currentAgentId: session.agentId,
					hasSession: !!session.sessionId,
					messageCount: messages.length,
				});
				// new-chat-in-directory always resolves to recreate-eager on the
				// CURRENT agent. (Previously restartSession(undefined, dir) ran
				// createSession(undefined) → the DEFAULT agent, silently dropping
				// the tab's agent. Keeping decision.agentId fixes that.)
				if (decision.kind !== "recreate-eager") return;

				if (agent.isSending) {
					await agent.cancelOperation();
				}
				if (messages.length > 0) {
					await autoExportIfEnabled("newChat", messages, session);
				}
				suggestions.mentions.toggleAutoMention(false);
				agent.clearMessages();
				setCarriedOver(null);
				// Change cwd, rebind the same agent, then acquire immediately through
				// the sole owner. The override ref covers the pre-render state window.
				setAgentCwd(directory);
				acquisitionCwdOverrideRef.current = directory;
				agent.setAgentWithoutSession(decision.agentId);
				void lazyAcquireNowRef.current?.();
				sessionHistory.invalidateCache();

				// I166: new-chat-in-directory is composer-terminal (in place,
				// same agent) — the user types next, so return focus.
				focusAfter("new-chat");
			} catch (error) {
				console.error(
					"[Agent Console] New chat in directory error:",
					error,
				);
			}
		},
		[
			messages,
			session,
			autoExportIfEnabled,
			suggestions.mentions.toggleAutoMention,
			agent.isSending,
			agent.cancelOperation,
			agent.clearMessages,
			agent.setAgentWithoutSession,
			sessionHistory.invalidateCache,
			focusAfter,
		],
	);

	const handleShowSidebarMenu = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			const menu = new Menu();
			registerOpenMenu(menu);

			// -- Switch agent section --
			menu.addItem((item: MenuItem) => {
				item.setTitle(t("chat.menu.switchAgent")).setIsLabel(true);
			});

			// Read the agent list fresh at click time so settings edits (added
			// or renamed custom agents) show without a tab remount — the
			// memoized availableAgents only recomputes on [plugin] (I105).
			const menuAgents = plugin.getAvailableAgents();
			// Mark at most ONE row: the first entry matching the tab's agentId.
			// A duplicate id (custom agent colliding a built-in) can no longer
			// produce two checkmarks; all configured agents stay visible (I105).
			const currentAgentIdx = indexOfCurrentAgent(
				menuAgents,
				session.agentId,
			);

			menuAgents.forEach((agent, idx) => {
				menu.addItem((item: MenuItem) => {
					item.setTitle(agent.displayName)
						.setChecked(idx === currentAgentIdx)
						.onClick(() => {
							void handleNewChatWithPersist(agent.id);
						});
				});
			});

			menu.addSeparator();

			// -- Actions section --
			menu.addItem((item: MenuItem) => {
				item.setTitle(t("chat.menu.openNewView"))
					.setIcon("copy-plus")
					.onClick(() => {
						void plugin.openNewChatViewWithAgent(
							plugin.settings.defaultAgentId,
						);
					});
			});

			menu.addItem((item: MenuItem) => {
				item.setTitle(t("chat.menu.newChatInDirectory"))
					.setIcon("folder-open")
					.onClick(() => {
						const modal = new ChangeDirectoryModal(
							plugin.app,
							agentCwd,
							(directory) => {
								void handleNewChatInDirectory(directory);
							},
						);
						modal.open();
					});
			});

			menu.addSeparator();

			menu.addItem((item: MenuItem) => {
				item.setTitle(t("chat.menu.pluginSettings"))
					.setIcon("settings")
					.onClick(() => {
						handleOpenSettings();
					});
			});

			showMenuAtEvent(menu, e);
		},
		[
			session.agentId,
			handleNewChatWithPersist,
			plugin,
			agentCwd,
			handleNewChatInDirectory,
			handleOpenSettings,
		],
	);

	// ============================================================
	// Effects - Session Lifecycle
	// ============================================================

	// Origin-aware session lifecycle: deliberately fresh tabs acquire once
	// initialize exposes capabilities; restored/read-only tabs wait for typing
	// or send. useLazySession remains the sole session/new owner.
	//
	// Decision #10: Eager initialize on mount for composer affordances.
	// Spawns the agent process so that slash commands, model list, and
	// mode list are available before the user types. The subsequent
	// createSession call (eager or interaction-triggered) sees isInitialized()=true
	// and skips re-initialization, going straight to newSession.
	useEffect(() => {
		if (acpClient.isInitialized()) return;
		const agentId = config?.agent || initialAgentId;
		if (!agentId) return;

		void (async () => {
			try {
				const { findAgentSettings, buildAgentConfigWithApiKey } =
					await import("../services/session-helpers");
				const agentSettings = findAgentSettings(
					plugin.settings,
					agentId,
				);
				if (!agentSettings) return;
				const agentConfig = buildAgentConfigWithApiKey(
					plugin.settings,
					agentSettings,
					agentId,
					vaultPath,
				);
				await acpClient.initialize(agentConfig);
				// I54: propagate the just-fetched capabilities into session
				// state so image paste works on a fresh tab before connecting.
				agent.applyInitCapabilities();
				logger.log(
					"[ChatPanel] Eager initialize complete for:",
					agentId,
				);
			} catch (e) {
				// Non-fatal: lazy path will retry on first keystroke
				logger.log(
					"[ChatPanel] Eager initialize failed (non-fatal):",
					e,
				);
			}
		})();
		// Run once on mount only. Re-eager-init on swap was reverted: model/mode
		// dropdowns come from the SESSION (newSession), not initialize(), so
		// eager re-init can't populate them pre-type (studio smoke (e),
		// 2026-06-25) — it only added a subprocess spawn on swap and competed
		// with the restart acquisition. Lazy acquisition on first send fetches
		// the swapped agent's session (and its model/mode list) correctly.
	}, []);

	// Queue-next-message (#82). Runtime-only queue-of-one shared by BOTH the
	// streaming case (send while a turn runs) and the pre-ready case (send
	// while session acquisition is in flight — Decision 9). The composer text
	// is the single source of truth; `isQueued` is never persisted. Declared
	// here (above lazySession + the flush effect + the send wrapper) so those
	// can reference it.
	// Effect handlers depend on handleSendMessage + lazySession (declared
	// below), so they are wired through a ref in the render body once those are
	// in scope (same forward-ref pattern as lazyResetRef).
	const queueEffectsRef = useRef<QueueEffectHandlers>({
		acquire: () => {},
		flushDispatch: () => {},
		clearComposer: () => {},
		cancelTurn: () => {},
	});
	const queue = useQueueOrchestration({
		acquire: () => queueEffectsRef.current.acquire(),
		flushDispatch: (message) =>
			queueEffectsRef.current.flushDispatch(message),
		clearComposer: () => queueEffectsRef.current.clearComposer(),
		cancelTurn: () => queueEffectsRef.current.cancelTurn(),
	});

	// Tracks whether the in-flight turn was cancelled by the user so the
	// turn-end flush HOLDS (does not auto-fire) per Decision 5. Reset at turn
	// start.
	const cancelledRef = useRef(false);

	const lazySession = useLazySession({
		// Restored sessionId from tab persistence. When non-null, the
		// hook calls loadExistingSession on first keystroke instead of
		// acquireNewSession.
		restoredSessionId: restoredSessionId ?? null,
		// Track C: when set, acquisition forks a NEW branch from this id
		// instead of loading/creating (restore/fork-in-new-tab).
		forkFromSessionId: restoredForkSessionId ?? null,
		// Deliberately fresh tabs and forks acquire as soon as initialize has
		// supplied capabilities. Restored/read-only tabs stay lazy.
		eagerAcquire:
			(tabOrigin === "fresh" || !!restoredForkSessionId) &&
			!!session.capabilities,

		acquireNewSession: useCallback(async () => {
			try {
				// Source of truth is the LIVE tab agent (session.agentId,
				// updated on switch via setAgentWithoutSession). The mount-time
				// config?.agent / initialAgentId snapshot is intentionally NOT
				// consulted — reading it was the original clobber (acquisition
				// used the frozen default agent after a switch). D1/D3.
				const effectiveAgent = selectAcquisitionAgent(
					agent.session.agentId,
					undefined,
				);
				logger.log(
					"[Lazy] Acquiring new session for agent:",
					effectiveAgent,
				);
				// No reuse-guard here: acquireNewSession ALWAYS creates a fresh
				// session. The old I53 `existingSid` reuse-guard read a stale
				// agent.session.sessionId and, on Restart agent (closeSession +
				// acquireNow), short-circuited to the just-closed session — the
				// agent never respawned and the tab hung on "Connecting" (studio
				// smoke (g), 2026-06-25; see restart-respawn-fresh.test.ts). The
				// original eager+lazy double-session/new the guard protected
				// against was removed when switch/new-chat moved onto the lazy
				// owner, so the guard is now redundant and was actively harmful.
				// I55: use the sessionId RETURNED by createSession instead
				// of reading agent.session.sessionId from a stale closure.
				// The setState inside createSession has not propagated to
				// this closure's `agent` reference yet, so the old read
				// returned null and left the message stuck in "Sending…".
				const overrideCwd =
					acquisitionCwdOverrideRef.current ?? undefined;
				acquisitionCwdOverrideRef.current = null;
				const sid = await agent.createSession(
					effectiveAgent,
					overrideCwd,
				);
				if (!sid) {
					return {
						ok: false as const,
						error: new Error(
							"Session creation produced no sessionId",
						),
					};
				}
				return { ok: true as const, sessionId: sid };
			} catch (err) {
				return {
					ok: false as const,
					error: err instanceof Error ? err : new Error(String(err)),
				};
			}
		}, [agent.createSession, agent.session.agentId, logger]),

		loadExistingSession: useCallback(
			async (sessionId: string) => {
				logger.log("[Lazy] Loading existing session:", sessionId);
				const result = await loadExistingSessionFlow({
					sessionId,
					cwd: agentCwd,
					// Suppress the agent's replay only when local history is
					// already displayed; otherwise let it through (I43 #12).
					haveLocalHistory:
						!!restoredMessages && restoredMessages.length > 0,
					loadSession: (id, cwd) => acpClient.loadSession(id, cwd),
					onLoaded: (r) =>
						void agent.updateSessionFromLoad(
							r.sessionId,
							r.modes,
							r.models,
							r.configOptions,
						),
					setIgnoreUpdates: agent.setIgnoreUpdates,
				});
				if (!result.ok) {
					logger.log(
						"[Lazy] loadSession failed, falling through to new session:",
						result.error,
					);
				}
				return result;
			},
			[
				restoredMessages,
				acpClient,
				agentCwd,
				agent.updateSessionFromLoad,
				agent.setIgnoreUpdates,
				logger,
			],
		),

		// Track C (RC-2) — agent-agnostic fork for a tab opened via Session
		// History "fork". `session/fork`-capable agents branch server-side
		// (context retained); others get a LOCAL branch (a fresh session seeded
		// with the transcript — the agent has no server-side history, so we
		// flag `lossy` and the disk-only-restore notice is shown). The branch
		// is persisted to history immediately so it appears + is renamable
		// before the first send.
		forkExistingSession: useCallback(
			async (originalSessionId: string) => {
				const agentId = session.agentId;
				const serverForks = session.capabilities?.forks ?? false;
				let newId: string;
				let lossy = false;
				try {
					if (serverForks) {
						const result = await acpClient.forkSession(
							originalSessionId,
							agentCwd,
						);
						void agent.updateSessionFromLoad(
							result.sessionId,
							result.modes,
							result.models,
							result.configOptions,
						);
						newId = result.sessionId;
					} else {
						const sid = await agent.createSession(agentId);
						if (!sid) {
							return {
								ok: false as const,
								error: new Error(
									"Fork (local branch) produced no sessionId",
								),
							};
						}
						newId = sid;
						lossy = true;
					}
				} catch (err) {
					return {
						ok: false as const,
						error:
							err instanceof Error ? err : new Error(String(err)),
					};
				}

				// Persist the branch to history through the SINGLE WRITER
				// (useSessionHistory.saveSessionMessages → SessionStore) — NEVER
				// a direct settingsService.saveSession, which would race the
				// turn-end save and clobber the title (the 723f868 bug; see
				// learned/skill-rules § single writer of record). The explicit
				// fork title is passed as suggestedTitle so it is set on create
				// and preserved across later no-title turn-end saves (forks get
				// no AI title; deriveSessionRecordTitle keeps the existing one).
				void sessionHistory.saveSessionMessages(
					newId,
					restoredMessages ?? [],
					restoredContextNotes ?? undefined,
					restoredForkTitle ??
						t("chat.tabs.forkPrefix", {
							label: t("chat.tabs.sessionFallback"),
						}),
				);
				// Invalidate the session-list cache so reopening Session History
				// re-fetches and shows the new branch. The 5-min cache was
				// populated when the modal was opened to fork, so without this
				// the reopened modal returns the stale pre-fork list (the old
				// forkSession called invalidateCache; the orchestration dropped
				// it).
				sessionHistory.invalidateCache();
				return { ok: true as const, sessionId: newId, lossy };
			},
			[
				session.agentId,
				session.capabilities,
				acpClient,
				agentCwd,
				agent.createSession,
				agent.updateSessionFromLoad,
				sessionHistory.saveSessionMessages,
				sessionHistory.invalidateCache,
				restoredMessages,
				restoredContextNotes,
				restoredForkTitle,
			],
		),

		sendPrompt: useCallback(async () => {
			// Queue flush is owned by ChatPanel's connect-flush effect
			// (below) — not by the hook's internal sendPrompt. Owning
			// the flush at the ChatPanel level lets us read
			// agent.session.sessionId from a post-render closure when
			// the user message threads through handleSendMessage.
		}, []),
	});

	// Wire the forward ref so the (earlier-declared) switch/new-chat dispatcher
	// can reset the lazy machine to idle. lazySession.reset is a stable
	// useCallback identity, so reassigning each render is a no-op cost.
	lazyResetRef.current = lazySession.reset;
	lazyAcquireNowRef.current = lazySession.acquireNow;

	// Wire the queue-orchestration effect handlers now that handleSendMessage and
	// lazySession are in scope. flushDispatch is ALWAYS the raw send — the
	// reducer's flushDispatch effect carries no dispatch choice, so the
	// re-enqueuing wrapper can never be wired into a flush (closes Q4).
	queueEffectsRef.current = {
		acquire: () => lazySession.onSendClick(""),
		flushDispatch: (message) =>
			void handleSendMessage(message.content, message.attachments),
		clearComposer: () => {
			setInputValue("");
			setAttachedFiles([]);
		},
		// #81: steer cancels the live turn via the RAW stop (NOT the
		// cancel-flag wrapper). handleStopGeneration awaits the FULL cancel
		// (discardPendingTurn → session/cancel → clearPendingUpdates); only once
		// it resolves do we dispatch `steerCancelSettled` to flush the redirect.
		// Flushing on the earlier turn-end edge would race clearPendingUpdates,
		// which would clobber the redirect turn's isSending back to false
		// (no working animation / no Stop — I165). This is the genuine
		// settle-before-send (Q1).
		cancelTurn: () => {
			void handleStopGeneration({ suppressRestore: true }).then(() => {
				queue.dispatch({ type: "steerCancelSettled" });
			});
		},
	};

	// Connect-flush effect (#82 Decision 9): when session acquisition completes
	// — the (connecting|idle)→ready transition — flush the pending queued
	// message through the normal send path. Keyed on the transition (not
	// "ready && !sending") so it stays disjoint from the turn-end flush: a turn
	// ending is busy→ready, owned by the gated turn-end flush, so this never
	// double-fires nor bypasses the hold-on-error/cancel gate. The
	// ready+sessionId guard is the I69 invariant (sessionId must be committed
	// before handleSendMessage reads it).
	// Connect-flush (#82 Decision 9 + I103 fix): dispatch acquisitionComplete
	// when acquisition completes. `decideConnectFlush` handles the restored/
	// loadSession path where agent.session.sessionId commits a render AFTER
	// lazySession.state becomes "ready" — it arms an await flag on the
	// acquisition edge and fires once the sessionId lands. Stays disjoint from
	// the turn-end flush (busy->ready never arms the flag; leaving `ready`
	// clears it), so it can't double-fire.
	const prevLazyStateRef = useRef<string>(lazySession.state);
	const awaitingSessionIdRef = useRef(false);
	useEffect(() => {
		const decision = decideConnectFlush({
			prevState: prevLazyStateRef.current,
			state: lazySession.state,
			hasSessionId: !!agent.session.sessionId,
			awaitingSessionId: awaitingSessionIdRef.current,
		});
		prevLazyStateRef.current = lazySession.state;
		awaitingSessionIdRef.current = decision.awaitingSessionId;
		if (decision.dispatchAcquisitionComplete) {
			queue.dispatch({ type: "acquisitionComplete", hasSessionId: true });
		}
		// A2UI-I08: acquisition failed outright. The reducer releases a held
		// detached action (a surface click has no composer text to retry from,
		// so holding it would strand the surface pending with the composer
		// blocked); a held composer message still holds per Decision 5.
		if (decision.dispatchAcquisitionFailed) {
			queue.dispatch({ type: "acquisitionFailed" });
		}
	}, [lazySession.state, agent.session.sessionId, queue.dispatch]);

	// Send wrapper: ready → handleSendMessage directly. Not-ready → enqueue the
	// message (queue-of-one) and trigger lazy acquisition; the connect-flush
	// effect above sends it once the session is ready. The normal UI routes
	// not-ready sends through handleQueueMessage (no composer clear); this
	// branch is the safety net for direct/broadcast callers.
	const handleSendWithLazyAcquisition = useCallback(
		async (content: string, attachments?: AttachedFile[]) => {
			if (lazySession.state === "ready" && agent.session.sessionId) {
				await handleSendMessage(content, attachments);
				return;
			}
			// Not ready (connecting/idle): the reducer holds the one pending
			// message and triggers acquisition; the connect-flush delivers on ready.
			queue.dispatch({
				type: "sendWhilePreReady",
				message: { content, attachments },
			});
		},
		[
			lazySession.state,
			agent.session.sessionId,
			handleSendMessage,
			queue.dispatch,
		],
	);

	// ============================================================
	// Queue Next Message (#82) — handlers
	// ============================================================
	// (the queue adapter + cancelledRef are declared earlier, above lazySession.)

	// Queue the composer's current content. Used for BOTH streaming (flushes on
	// turn-end) and pre-ready/connecting (flushes on connect — Decision 9). The
	// composer text stays put (locked by InputArea via isQueued) — it remains
	// the single source of truth. enqueue returning false (queue full) is the
	// queue-of-one guard that blocks a silent 2nd-message overwrite.
	const handleQueueMessage = useCallback(
		(content: string, attachments?: AttachedFile[]) => {
			const trimmed = content.trim();
			if (!trimmed && (attachments?.length ?? 0) === 0) return;
			const message = { content: trimmed, attachments };
			// Live session (ready/busy/permission) → hold, flush on turn-end.
			// No live session (idle/connecting/error) → hold + acquire, flush on
			// connect. Routing by live-session state (not just "ready") keeps a
			// message queued mid-stream (busy) off the acquire path (I109). The
			// reducer enforces queue-of-one.
			queue.dispatch({
				type: decideQueuedSendKind(lazySession.state),
				message,
			});
		},
		[lazySession.state, queue.dispatch],
	);

	// Edit: unlock the composer (clear the queued flag) but KEEP the text so
	// the user can modify it and re-queue on the next send.
	const handleEditQueued = useCallback(() => {
		queue.dispatch({ type: "editQueued" });
	}, [queue.dispatch]);

	// Delete: clear the slot AND empty the composer (discard the message).
	// (Edit keeps the text; Delete removes it — the label distinction the user
	// flagged: "Cancel" wrongly implied the text returns to the composer.)
	const handleDeleteQueued = useCallback(() => {
		queue.dispatch({ type: "deleteQueued" });
	}, [queue.dispatch]);

	// Steer (#81): interrupt the live turn and redirect. Dispatches
	// steerWhileStreaming — the reducer holds the composer text flagged as a
	// steer and emits cancelTurn (raw stop). The composer stays locked showing
	// the steering banner; on the turn-end the cancel produces, the reducer
	// flushes the held message through the raw send (settle-before-send by
	// construction). Queue-of-one still applies — the resolver only yields
	// "steer" when nothing is queued.
	const handleSteerMessage = useCallback(
		(content: string, attachments?: AttachedFile[]) => {
			const trimmed = content.trim();
			if (!trimmed && (attachments?.length ?? 0) === 0) return;
			queue.dispatch({
				type: "steerWhileStreaming",
				message: { content: trimmed, attachments },
			});
		},
		[queue.dispatch],
	);

	// Stop wrapper: mark the in-flight turn as user-cancelled so the flush
	// effect HOLDS any queued message (Decision 5) instead of firing it into
	// the cancelled turn. Used by every stop entry point (button, hotkey,
	// broadcast-cancel) via handleStopGenerationRef.
	const handleStopWithCancelFlag = useCallback(async () => {
		cancelledRef.current = true;
		await handleStopGeneration();
	}, [handleStopGeneration]);

	// Mirror the agent's server-session metadata into the local cache on
	// connect (Session History Source Model Decision 1). One session/list of
	// metadata for a listing agent, persisted so the Agent view is non-empty
	// cold and shows its freshness even while disconnected. Best-effort.
	useEffect(() => {
		if (!isSessionReady || !sessionHistory.capabilities.listsSessions)
			return;
		void sessionHistory.syncAgentSessionMetaCache();
	}, [
		isSessionReady,
		sessionHistory.capabilities.listsSessions,
		sessionHistory.syncAgentSessionMetaCache,
	]);

	// Apply configured model when session is ready
	useEffect(() => {
		if (!config?.model || !isSessionReady) return;

		// Prefer configOptions if available
		if (session.configOptions) {
			const modelOption = session.configOptions.find(
				(o) => o.category === "model",
			);
			if (modelOption && modelOption.currentValue !== config.model) {
				const valueExists = flattenConfigSelectOptions(
					modelOption.options,
				).some((o) => o.value === config.model);
				if (valueExists) {
					logger.log(
						"[ChatPanel] Applying configured model via configOptions:",
						config.model,
					);
					void agent.setConfigOption(modelOption.id, config.model);
				}
			}
			return;
		}

		// Fallback to legacy models
		if (session.models) {
			const modelExists = session.models.availableModels.some(
				(m) => m.modelId === config.model,
			);
			if (modelExists && session.models.currentModelId !== config.model) {
				logger.log(
					"[ChatPanel] Applying configured model:",
					config.model,
				);
				void agent.setModel(config.model);
			}
		}
	}, [
		config?.model,
		isSessionReady,
		session.configOptions,
		session.models,
		agent.setConfigOption,
		agent.setModel,
		logger,
	]);

	// Refs for cleanup (to access latest values in cleanup function)
	const messagesRef = useRef(messages);
	const sessionRef = useRef(session);
	const autoExportRef = useRef(autoExportIfEnabled);
	const closeSessionRef = useRef(agent.closeSession);
	messagesRef.current = messages;
	sessionRef.current = session;
	autoExportRef.current = autoExportIfEnabled;
	closeSessionRef.current = agent.closeSession;

	// Persist context notes when they change mid-session (T13 persistence).
	// Refs keep the dep list to notes only — avoids a write on every
	// streamed message update.
	useEffect(() => {
		const sid = sessionRef.current.sessionId;
		if (sid && messagesRef.current.length > 0) {
			void sessionHistory.saveSessionMessages(
				sid,
				messagesRef.current,
				contextNotes.notes,
			);
		}
	}, [contextNotes.notes, sessionHistory.saveSessionMessages]);

	// Cleanup on unmount only - auto-export and close session
	useEffect(() => {
		return () => {
			logger.log("[ChatPanel] Cleanup: auto-export and close session");
			void (async () => {
				try {
					await autoExportRef.current(
						"closeChat",
						messagesRef.current,
						sessionRef.current,
					);
					await closeSessionRef.current();
				} catch (error) {
					logger.error("[ChatPanel] Cleanup error:", error);
				}
			})();
		};
	}, [logger]);

	// ============================================================
	// Effects - Update Check
	// ============================================================
	useEffect(() => {
		plugin
			.checkForUpdates()
			.then(setIsUpdateAvailable)
			.catch((error) => {
				logger.error("Failed to check for updates:", error);
			});
	}, [plugin, logger]);

	// ============================================================
	// Effects - Agent Update Check
	// ============================================================
	useEffect(() => {
		if (!isSessionReady || !session.agentInfo?.name) {
			return;
		}

		checkAgentUpdate(
			session.agentInfo as { name: string; version?: string },
		)
			.then(setAgentUpdateNotification)
			.catch((error) => {
				logger.error("Failed to check agent update:", error);
			});
	}, [isSessionReady, session.agentInfo, logger]);

	// ============================================================
	// Effects - Save Session Messages on Turn End
	// ============================================================
	// Stable refs for the completion-notification onclick handler. The handler
	// is attached to a Notification object and fires outside React (possibly
	// long after the effect ran), so it must read current values via refs
	// rather than the effect's captured closure. viewId is stable per panel,
	// so it can be closed over directly.
	const tabLabelRef = useRef(tabLabel);
	tabLabelRef.current = tabLabel;
	const onSwitchToTabRef = useRef(onSwitchToTab);
	onSwitchToTabRef.current = onSwitchToTab;

	const prevIsSendingRef = useRef<boolean>(false);

	useEffect(() => {
		const wasSending = prevIsSendingRef.current;
		prevIsSendingRef.current = isSending;

		// Save when turn ends (isSending: true -> false) and has messages
		if (
			wasSending &&
			!isSending &&
			session.sessionId &&
			messages.length > 0
		) {
			void sessionHistory.saveSessionMessages(
				session.sessionId,
				messages,
				contextNotes.notes,
				agent.suggestedTitle ?? undefined,
			);
			logger.log(
				`[ChatPanel] Session messages saved: ${session.sessionId}`,
			);

			// System notification on response completion. The title carries the
			// tab label (which tab finished); a click focuses the owning vault
			// window (I52) AND switches to that tab. Per-tab tag prevents the OS
			// from coalescing back-to-back completions from different tabs.
			if (
				shouldNotifySystem({
					visibilityState: activeDocument.visibilityState,
					hasFocus: activeDocument.hasFocus(),
					enabled: settings.enableSystemNotifications,
				})
			) {
				const { title, body, tag } = buildCompletionNotificationContent(
					{
						tabLabel: tabLabelRef.current,
						agentLabel: activeAgentLabel,
						tabId: viewId,
					},
				);
				const completionNotification = new Notification(title, {
					body,
					tag,
				});
				// Retain the Notification so its click handler survives GC
				// (electron#12690/#16922) — a bare local const is collected once
				// this effect run exits, and a later click (esp. from macOS
				// Notification Center) then does nothing. See I52 recurrence
				// 2026-07-09.
				retainNotification(completionNotification, () => {
					// Retained Electron fallback for the OS window raise (I52);
					// the sanctioned reveal follows, plus one bounded post-
					// activation re-assert — the macOS activation lands async
					// AFTER this handler, so a single reveal can lose the race
					// (I52 recurrence 2026-07-14).
					focusOwningWindow();
					runNotificationClick({
						tabId: viewId,
						onSwitchToTab: onSwitchToTabRef.current,
						revealOwningLeaf: () => viewHost.revealOwningLeaf(),
						owningWindowHasFocus: () =>
							containerRef.current?.ownerDocument.hasFocus() ??
							false,
						schedule: (fn, ms) => window.setTimeout(fn, ms),
					});
				});
			}
		}
	}, [
		isSending,
		session.sessionId,
		messages,
		sessionHistory.saveSessionMessages,
		agent.suggestedTitle,
		settings.enableSystemNotifications,
		activeAgentLabel,
		logger,
	]);

	// Debounced incremental save so the message tail survives reload/quit
	// even mid-stream or before a turn ends (I48). Extracted to a hook with
	// an unmount-flush + max-wait so a mid-stream reload does not lose the
	// in-flight turn. The turn-end save above is kept for the notification.
	const { flushPending: flushSessionSave } = useDebouncedSessionSave(
		session.sessionId,
		messages,
		contextNotes.notes,
		sessionHistory.saveSessionMessages,
	);

	// ============================================================
	// Effects - System Notification on Permission Request
	// ============================================================
	const prevHasActivePermissionRef = useRef<boolean>(false);

	useEffect(() => {
		const wasActive = prevHasActivePermissionRef.current;
		prevHasActivePermissionRef.current = agent.hasActivePermission;

		// Notify when permission transitions from inactive to active
		if (
			!wasActive &&
			agent.hasActivePermission &&
			shouldNotifySystem({
				visibilityState: activeDocument.visibilityState,
				hasFocus: activeDocument.hasFocus(),
				enabled: settings.enableSystemNotifications,
			})
		) {
			// I52: bind onclick so a click focuses the vault window that owns
			// this panel, not Electron's most-recently-active window.
			const permissionNotification = new Notification("Agent Console", {
				// I52 round 7.5: tag with the tab id so the startup sweep can
				// match and clear an orphaned permission notification (same
				// scheme as the completion notification, whose tag is the tab
				// id). A pending permission means the turn has not completed, so
				// a permission and a completion notification for the same tab
				// never meaningfully coexist — sharing the tab-id tag is benign.
				tag: viewId,
				body: t("chat.notifications.permissionBody", {
					agent: activeAgentLabel,
				}),
			});
			// Retain so the click handler survives GC (see completion site above).
			retainNotification(permissionNotification, () => {
				focusOwningWindow();
				runNotificationClick({
					tabId: viewId,
					// Dispatch to the producing tab — the permission path never
					// had tab dispatch (only completion got it in the reveal-leaf
					// fix); caught by SF-6 smoke 2026-07-14.
					onSwitchToTab: onSwitchToTabRef.current,
					revealOwningLeaf: () => viewHost.revealOwningLeaf(),
					owningWindowHasFocus: () =>
						containerRef.current?.ownerDocument.hasFocus() ?? false,
					schedule: (fn, ms) => window.setTimeout(fn, ms),
				});
			});
		}
	}, [
		agent.hasActivePermission,
		settings.enableSystemNotifications,
		activeAgentLabel,
	]);

	// ============================================================
	// Effects - Tab State & Label Reporting
	// ============================================================
	// The tab icon state is a PURE DERIVATION over the connection lifecycle
	// plus intent signals, not a chain of edge-triggered state-machine
	// transitions. The former approach dropped the busy glyph in two ways:
	//   - `startBusy` was gated on `state === "ready"` at the `isSending`
	//     rising edge, but a lazy tab's first send raises `isSending` while
	//     still "connecting", so busy was never entered — the active tab
	//     showed ● "ready" through the whole streamed reply instead of ◐.
	//   - a mid-turn permission resolve returned the machine to "ready" while
	//     the agent kept working, stranding the tab at ready.
	// `deriveTabState` recomputes every render, so a missed edge can't strand
	// the icon (see resolvers/tab-state.ts + its truth-table test).
	const tabState = deriveTabState({
		lifecycle: lazySession.state,
		isSending,
		hasActivePermission: agent.hasActivePermission,
	});
	useEffect(() => {
		onStateChangeRef.current?.(tabState);
	}, [tabState]);

	// Report label from first user message
	useEffect(() => {
		if (!onLabelChangeRef.current || labelReportedRef.current) return;
		const label = deriveTabLabel(messages);
		if (
			shouldReportInterimLabel({
				alreadyReported: labelReportedRef.current,
				derivedLabel: label,
				titleStrategy: settings.titleStrategy,
			})
		) {
			onLabelChangeRef.current(label as string);
			labelReportedRef.current = true;
		}
	}, [messages]);

	// F03: swap in the agent-suggested title once the head of the first reply
	// resolves a <title>…</title> marker. Routes through the same onLabelChange
	// (custom=false) as the interim prompt-derived label, so setTabLabel's
	// manual-rename guard preserves a user rename (T55) and the title simply
	// replaces the interim otherwise (T52). No marker → suggestedTitle stays
	// null → this never fires, interim is retained (T54). The ref de-dupes
	// repeat fires and resets when the title clears (new chat).
	const lastSuggestedTitleRef = useRef<string | null>(null);
	useEffect(() => {
		const title = agent.suggestedTitle;
		if (!title) {
			lastSuggestedTitleRef.current = null;
			return;
		}
		if (title === lastSuggestedTitleRef.current) return;
		lastSuggestedTitleRef.current = title;
		onLabelChangeRef.current?.(title);
		labelReportedRef.current = true;
	}, [agent.suggestedTitle]);

	// I114: propagate the resolved AI title to the session-history record so
	// the history pane matches the tab label. Routed through the single
	// serialized writer (sessionHistory.applySessionTitle → SessionStore) so it
	// cannot be clobbered by — nor clobber — a concurrent turn-end / debounced
	// save (the stale-snapshot race that defeated the earlier flat hook). The
	// ref de-dupes repeat fires and resets when the title clears (new chat);
	// it no-ops until a sessionId exists, then fires once the id arrives.
	const lastSyncedTitleRef = useRef<string | null>(null);
	useEffect(() => {
		const title = agent.suggestedTitle;
		if (!title) {
			lastSyncedTitleRef.current = null;
			return;
		}
		if (title === lastSyncedTitleRef.current) return;
		const sid = agent.session.sessionId;
		if (!sid) return;
		lastSyncedTitleRef.current = title;
		sessionHistory.applySessionTitle(sid, title, agentCwd);
	}, [
		agent.suggestedTitle,
		agent.session.sessionId,
		agentCwd,
		sessionHistory.applySessionTitle,
	]);

	// Report the session ID that is safe to persist and use for history lookup.
	useEffect(() => {
		// Restored IDs survive while their tabs are inert, and a reconnected live
		// ID supersedes them. A fresh eager session stays runtime-only until its
		// first message: before then there is no saved-session record or transcript
		// for restart to restore, so persisting the ID would create an orphan slice.
		onSessionIdChange?.(
			resolveSessionIdForSave(
				session.sessionId ?? null,
				restoredSessionId ?? null,
				messages.length > 0,
			),
		);
	}, [
		onSessionIdChange,
		session.sessionId,
		restoredSessionId,
		messages.length,
	]);

	// ============================================================
	// Auto-default context crystallizes on FIRST SEND in useChatActions
	// (Decision #26, I68) — not seeded at mount. The provisional dashed pill
	// is derived in ContextStrip from the live active note.
	// ============================================================

	// ============================================================
	// Effects - Workspace Events (Hotkeys)
	// ============================================================

	// I74: grab/ungrab the active editor note (active-note-scoped membership toggle).
	const handleToggleActiveNoteGrab = useCallback(() => {
		const path = selectionTracker.activeNotePath;
		// Count the provisional auto-default pill as present so a fresh
		// session's first press removes it instead of committing it (I74).
		const provisionalPath = computeProvisionalPath({
			settingOn: settings.activeNoteAsDefaultContext,
			suppressed: autoDefaultSuppressed,
			messageCount: messages.length,
			activeNotePath: path,
			committed: contextNotes.notes,
		});
		const action = decideGrabToggle({
			activeNotePath: path,
			activeNoteName: selectionTracker.activeNoteName,
			committed: contextNotes.notes,
			provisionalPath,
		});
		if (action.kind === "grab") {
			contextNotes.add(action.path, "user");
		} else if (action.kind === "ungrab") {
			contextNotes.remove(action.path);
			// Ungrab also suppresses the per-chat auto-default so it sticks.
			setAutoDefaultSuppressed(true);
		}
		new Notice(action.notice);
	}, [
		selectionTracker.activeNotePath,
		selectionTracker.activeNoteName,
		contextNotes,
		settings.activeNoteAsDefaultContext,
		autoDefaultSuppressed,
		messages.length,
		setAutoDefaultSuppressed,
	]);
	const handleToggleActiveNoteGrabRef = useRef(handleToggleActiveNoteGrab);
	handleToggleActiveNoteGrabRef.current = handleToggleActiveNoteGrab;

	// Refs for workspace event handlers (avoids re-registering on every render)
	const handleNewChatWithPersistRef = useRef(handleNewChatWithPersist);
	const approveActivePermissionRef = useRef(agent.approveActivePermission);
	const rejectActivePermissionRef = useRef(agent.rejectActivePermission);
	const handleStopGenerationRef = useRef(handleStopWithCancelFlag);
	const handleExportChatRef = useRef(handleExportChat);
	// Degrade a queued message to a preserved draft on reload (soft = resume,
	// hard = respawn) so it does NOT flush into the just-reloaded session, which
	// isn't prompt-ready yet (I103/(l): the agent returns "Session not found").
	// The queue adapter is in scope here, so no forward ref is needed.
	const handleReloadWithQueue = useCallback(
		(hard: boolean) => {
			queue.dispatch(
				hard
					? { type: "respawn" }
					: { type: "resume", canResume: true },
			);
			return handleReload(hard);
		},
		[queue.dispatch, handleReload],
	);
	const handleReloadRef = useRef(handleReloadWithQueue);
	handleNewChatWithPersistRef.current = handleNewChatWithPersist;
	approveActivePermissionRef.current = agent.approveActivePermission;
	rejectActivePermissionRef.current = agent.rejectActivePermission;
	handleStopGenerationRef.current = handleStopWithCancelFlag;
	handleExportChatRef.current = handleExportChat;
	handleReloadRef.current = handleReloadWithQueue;

	useEffect(() => {
		const workspace = plugin.app.workspace;
		const ws = workspace as unknown as {
			on: (
				name: string,
				callback: (...args: never[]) => void,
			) => ReturnType<typeof workspace.on>;
		};

		const refs = [
			// Toggle active note in context: grab / ungrab (I74)
			ws.on(
				"agent-console:toggle-auto-mention",
				(targetViewId?: string) => {
					if (targetViewId && targetViewId !== viewId) return;
					handleToggleActiveNoteGrabRef.current();
				},
			),

			// New chat requested (from "New chat" or "Switch agent to" commands)
			ws.on(
				"agent-console:new-chat-requested",
				(targetViewId?: string, agentId?: string) => {
					if (targetViewId && targetViewId !== viewId) return;
					void handleNewChatWithPersistRef.current(agentId);
				},
			),

			// Approve active permission
			ws.on(
				"agent-console:approve-active-permission",
				(targetViewId?: string) => {
					if (targetViewId && targetViewId !== viewId) return;
					void (async () => {
						try {
							const success =
								await approveActivePermissionRef.current();
							if (!success) {
								new Notice(
									t("notices.noActivePermissionRequest"),
								);
							}
						} catch (error) {
							console.error(
								"[Agent Console] Approve permission error:",
								error,
							);
						}
					})();
				},
			),

			// Reject active permission
			ws.on(
				"agent-console:reject-active-permission",
				(targetViewId?: string) => {
					if (targetViewId && targetViewId !== viewId) return;
					void (async () => {
						try {
							const success =
								await rejectActivePermissionRef.current();
							if (!success) {
								new Notice(
									t("notices.noActivePermissionRequest"),
								);
							}
						} catch (error) {
							console.error(
								"[Agent Console] Reject permission error:",
								error,
							);
						}
					})();
				},
			),

			// Cancel current message
			ws.on("agent-console:cancel-message", (targetViewId?: string) => {
				if (targetViewId && targetViewId !== viewId) return;
				void handleStopGenerationRef.current();
			}),

			// Export chat
			ws.on("agent-console:export-chat", (targetViewId?: string) => {
				if (targetViewId && targetViewId !== viewId) return;
				void handleExportChatRef.current();
			}),

			// Reload session (soft — resume same session under fresh harness)
			ws.on("agent-console:reload-session", (targetViewId?: string) => {
				if (targetViewId && targetViewId !== viewId) return;
				void handleReloadRef.current(false);
			}),

			// Hard reload session (fresh session under fresh harness)
			ws.on(
				"agent-console:hard-reload-session",
				(targetViewId?: string) => {
					if (targetViewId && targetViewId !== viewId) return;
					void handleReloadRef.current(true);
				},
			),
		];

		return () => {
			for (const ref of refs) {
				workspace.offref(ref);
			}
		};
	}, [plugin.app.workspace, plugin.lastActiveChatViewId, viewId]);

	// ============================================================
	// Effects - Focus Tracking
	// ============================================================
	const containerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const handleFocus = () => {
			// Use viewHost.viewId (the registry-recognized container ID).
			// Writing the bare `viewId` prop would be tab.tabId on sidebar
			// tabs and silently rejected by ViewRegistry.setFocused (I34).
			plugin.setLastActiveChatViewId(viewHost.viewId);
		};

		const container = containerRef.current;
		if (!container) return;

		container.addEventListener("focus", handleFocus, true);
		container.addEventListener("click", handleFocus);

		return () => {
			container.removeEventListener("focus", handleFocus, true);
			container.removeEventListener("click", handleFocus);
		};
	}, [plugin, viewHost]);

	// ============================================================
	// Callback Registration for IChatViewContainer
	// ============================================================
	// Use refs so callbacks always access latest values
	const inputValueRef = useRef(inputValue);
	const attachedFilesRef = useRef(attachedFiles);
	const isSendingRef = useRef(isSending);
	const sessionHistoryLoadingRef = useRef(sessionHistory.loading);
	const handleSendMessageRef = useRef(handleSendWithLazyAcquisition);
	inputValueRef.current = inputValue;
	attachedFilesRef.current = attachedFiles;
	isSendingRef.current = isSending;
	sessionHistoryLoadingRef.current = sessionHistory.loading;
	handleSendMessageRef.current = handleSendWithLazyAcquisition;
	// Fresh lazy-session state for the once-registered broadcast/send callbacks
	// (the lazySession object is captured by closure and would otherwise be
	// stale between registrations). Feeds deriveSendAffordance / isSessionLive.
	const lazyStateRef = useRef(lazySession.state);
	lazyStateRef.current = lazySession.state;

	// Queue refs (#82) — read latest queue state from the once-registered
	// broadcast/send callbacks (same ref pattern as the values above).
	const isQueuedRef = useRef(queue.isQueued);
	const handleQueueMessageRef = useRef(handleQueueMessage);
	isQueuedRef.current = queue.isQueued;
	handleQueueMessageRef.current = handleQueueMessage;

	// ============================================================
	// Quick Prompts (picker / chips) — bridge + actions
	// ============================================================
	// The bridge exposes this tab's live composer/queue/selection state and the
	// fire/insert effects to the pure engine. Built once from stable refs +
	// setters; every method reads `.current` so it never goes stale.
	const quickPromptBridge = useMemo<QuickPromptComposerBridge>(
		() =>
			createQuickPromptBridge({
				getComposerText: () => inputValueRef.current,
				// Read the eagerly-captured selection text from VaultService.
				// The chat panel becoming active nulls
				// getActiveViewOfType(MarkdownView) AND workspace.activeEditor,
				// and an unfocused leaf's getSelection() returns "" — so the
				// selection cannot be read lazily here; it is captured while the
				// editor was focused (QP-I03).
				getSelectionText: () => vaultService.getActiveSelectionText(),
				isSending: () => isSendingRef.current,
				isSessionLive: () => isSessionLive(lazyStateRef.current),
				isQueued: () => isQueuedRef.current,
				setComposerText: (text) => setInputValue(text),
				queueMessage: (text) =>
					handleQueueMessageRef.current(text, undefined),
				sendMessage: (text) => {
					void handleSendMessageRef.current(text, undefined);
				},
				openInNewTab: (text, opts) => onOpenInNewTab?.(text, opts),
				getContainer: () => containerRef.current,
				notify: (message) =>
					new Notice(t("notices.prefixed", { message })),
			}),
		[plugin, onOpenInNewTab],
	);

	const quickPrompts = useQuickPrompts(
		plugin.quickPromptLibrary,
		quickPromptBridge,
	);
	const runQuickPromptRef = useRef(quickPrompts.runQuickPrompt);
	runQuickPromptRef.current = quickPrompts.runQuickPrompt;

	// Bumped by the "Quick prompts: Search" command (single search path) to
	// focus the composer + insert ! via InputArea's handleSearchAll.
	const [qpSearchSignal, setQpSearchSignal] = useState(0);

	// Consume a one-shot newTab seed: this tab was just spawned by a `newTab`
	// quick prompt fired from another tab. `send` dispatches through the same
	// fire/queue path the composer uses (queues until the fresh lazy session
	// connects, I69); otherwise we only seed the composer for editing.
	const initialPromptConsumedRef = useRef(false);
	useEffect(() => {
		if (initialPromptConsumedRef.current || !initialPrompt) return;
		initialPromptConsumedRef.current = true;
		if (initialPrompt.send) {
			quickPromptBridge.fireOrQueue(initialPrompt.text);
		} else {
			setInputValue(initialPrompt.text);
			focusAfter("seed-initial-prompt");
		}
	}, [initialPrompt, quickPromptBridge, focusAfter]);

	// Recompute the matched set when the ACTIVE note's metadata cache changes —
	// not just on path change. `metadataCache` is a stable ref, so on a
	// cold-cache first open (frontmatter not parsed yet) or an in-place
	// property/tag edit, the chip set would otherwise stay stale until a
	// navigation forced a recompute (QP-I21: TCOM cold-open + property-edit).
	const [activeNoteMetaVersion, setActiveNoteMetaVersion] = useState(0);
	useEffect(() => {
		const ref = plugin.app.metadataCache.on("changed", (file) => {
			if (file.path === selectionTracker.activeNotePath) {
				setActiveNoteMetaVersion((v) => v + 1);
			}
		});
		return () => plugin.app.metadataCache.offref(ref);
	}, [plugin.app.metadataCache, selectionTracker.activeNotePath]);

	// Contextual chips: prompts whose `show when:` conditions match the active
	// note (its tags + frontmatter), plus `always show` prompts. Recomputed on
	// editor-note switch (activeNotePath), active-note metadata change, and
	// library reconcile, so the matched set stays live.
	const matchedQuickPrompts = useMemo(() => {
		const path = selectionTracker.activeNotePath;
		const cache = path ? plugin.app.metadataCache.getCache(path) : null;
		const tags = cache ? (getAllTags(cache) ?? []) : [];
		const frontmatter = cache?.frontmatter ?? null;
		return matchPromptsForNote(quickPrompts.prompts, { tags, frontmatter });
	}, [
		quickPrompts.prompts,
		selectionTracker.activeNotePath,
		plugin.app.metadataCache,
		activeNoteMetaVersion,
	]);

	// ============================================================
	// Effects - Flush queued message on turn completion (#82)
	// ============================================================
	// Reset the cancel flag at turn start; on turn end (isSending true -> false)
	// dispatch `turnEnded` to the queue-orchestration reducer, which owns the
	// flush-vs-hold decision (holds on error/cancel — Decision 5) and emits a
	// RAW flushDispatch on flush, after clearing the composer so
	// draft-preservation persists "" (no stale-draft resurrection).
	const prevIsSendingForQueueRef = useRef(false);
	useEffect(() => {
		const wasSending = prevIsSendingForQueueRef.current;
		prevIsSendingForQueueRef.current = isSending;

		// Turn start: clear the cancel flag for the new turn.
		if (!wasSending && isSending) {
			cancelledRef.current = false;
			return;
		}

		// Turn end: hand the outcome to the reducer, which owns flush-vs-hold
		// (hold on error/cancel — Decision 5) and, on flush, emits clearComposer +
		// a RAW flushDispatch. The reducer effect carries no dispatch choice, so
		// the re-enqueuing wrapper can't be used — closing Q4 by construction.
		const turnEnded = wasSending && !isSending;
		if (turnEnded) {
			queue.dispatch({
				type: "turnEnded",
				hadError: errorInfo !== null,
				wasCancelled: cancelledRef.current,
			});
		}
	}, [isSending, errorInfo, queue.dispatch]);

	useEffect(() => {
		onRegisterCallbacks?.({
			flushSessionSave,
			getDisplayName: () => activeAgentLabel,
			getInputState: () => ({
				text: inputValueRef.current,
				files: attachedFilesRef.current,
			}),
			setInputState: (state) => {
				setInputValue(state.text);
				setAttachedFiles(state.files);
			},
			canSend: () => {
				const hasContent =
					inputValueRef.current.trim() !== "" ||
					attachedFilesRef.current.length > 0;
				// Single source of truth for send-enablement (deriveSendAffordance).
				// History load maps to `isRestoringSession`. (I40/I41/I70 cluster.)
				return deriveSendAffordance({
					lazyState: lazyStateRef.current,
					isSending: isSendingRef.current,
					isQueued: isQueuedRef.current,
					hasContent,
					isRestoringSession: sessionHistoryLoadingRef.current,
				}).canSend;
			},
			sendMessage: async () => {
				const currentInput = inputValueRef.current;
				const currentFiles = attachedFilesRef.current;
				// Allow sending if there's text OR attachments
				if (!currentInput.trim() && currentFiles.length === 0) {
					return false;
				}
				// Don't require an already-ready session: defer to
				// handleSendWithLazyAcquisition, which queues the message and
				// acquires the session for idle/connecting tabs (matches the
				// send button). Only an in-flight history load blocks. (I70)
				if (sessionHistoryLoadingRef.current) {
					return false;
				}

				const messageToSend = currentInput.trim();
				const filesToSend =
					currentFiles.length > 0 ? [...currentFiles] : undefined;

				// QUEUE instead of dispatching when a turn is streaming OR the
				// session isn't ready yet (#82 Decision 9 — one pending message
				// for both states). Broadcast-send inherits this for free. Keep
				// the composer text in place (it's the queued message, locked by
				// InputArea); handleQueueMessage enqueues and, when pre-ready,
				// triggers acquisition so it flushes on connect. A tab already
				// holding a queued message is skipped upstream by broadcast; the
				// queue-of-one cap is the defensive backstop here.
				if (
					isSendingRef.current ||
					!isSessionLive(lazyStateRef.current)
				) {
					if (isQueuedRef.current) return false;
					handleQueueMessageRef.current(messageToSend, filesToSend);
					return true;
				}

				// Ready + idle → normal dispatch (clears the composer).
				setInputValue("");
				setAttachedFiles([]);

				try {
					await handleSendMessageRef.current(
						messageToSend,
						filesToSend,
					);
				} catch (error) {
					console.error("[Agent Console] Send message error:", error);
				}
				return true;
			},
			cancelOperation: async () => {
				if (isSendingRef.current) {
					try {
						await handleStopGenerationRef.current();
					} catch (error) {
						console.error(
							"[Agent Console] Cancel operation error:",
							error,
						);
					}
				}
			},
			hasPendingQueue: () => isQueuedRef.current,
			runQuickPrompt: (prompt, opts) =>
				runQuickPromptRef.current(prompt, opts),
			startQuickPromptSearch: () => setQpSearchSignal((n) => n + 1),
			saveComposerAsQuickPrompt: () => {
				const text = inputValueRef.current;
				void plugin.createQuickPromptNote({
					label: deriveLabelFromComposer(text),
					body: text,
				});
			},
			getWorkingDirectory: () => agentCwd,
			openHistory: () => handleOpenHistoryRef.current(),
		});
	}, [onRegisterCallbacks, activeAgentLabel, agentCwd]);

	// ============================================================
	// Render
	// ============================================================
	const chatFontSizeStyle =
		settings.displaySettings.fontSize !== null
			? ({
					"--ac-chat-font-size": `${settings.displaySettings.fontSize}px`,
				} as React.CSSProperties)
			: undefined;

	const headerElement = (
		<ChatHeader
			agentLabel={activeAgentLabel}
			headerSegments={{
				...headerSegments,
				isLazyIdle: lazySession.state === "idle",
				isConnecting: lazySession.state === "connecting",
			}}
			isUpdateAvailable={isUpdateAvailable}
			onUpdateClick={handleOpenCommunityPlugins}
			onReload={(hard) => {
				void handleReloadWithQueue(hard);
				focusAfter("reload");
			}}
			isReloading={isReloading}
			onExportChat={() => void handleExportChat()}
			onShowMenu={handleShowSidebarMenu}
			onOpenHistory={handleOpenHistory}
			sharedLinks={sharedLinks}
			onOpenSharedLink={handleOpenSharedLink}
		/>
	);

	const cwdBanner = deriveCwdBanner(agentCwd, vaultRoot) ? (
		<div className="agent-client-cwd-banner" aria-label={agentCwd}>
			<span
				className="agent-client-cwd-banner-icon"
				ref={(el) => {
					if (el) setIcon(el, "folder-open");
				}}
			/>
			<span className="agent-client-cwd-banner-path">{agentCwd}</span>
		</div>
	) : null;

	// Layer 2 — getting-started empty state. Lazily detect installed agents
	// the first time an empty, not-yet-ready panel renders; if the current
	// agent is not among them, surface one-click picks + open-settings instead
	// of a dead-end "Connecting..." that never resolves. Detection is the
	// session-cached, login-shell-aware plugin probe (never on the load path).
	const [detectedAgentIds, setDetectedAgentIds] =
		useState<Set<string> | null>(null);

	const isEmptyAndIdle =
		messages.length === 0 && !isSessionReady && !sessionHistory.loading;

	useEffect(() => {
		if (!isEmptyAndIdle || detectedAgentIds !== null) return;
		let cancelled = false;
		void plugin.detectAgents().then((ids) => {
			if (!cancelled) setDetectedAgentIds(ids);
		});
		return () => {
			cancelled = true;
		};
	}, [isEmptyAndIdle, detectedAgentIds, plugin]);

	// I-FRO5: when a built-in agent's command changes in settings (e.g. the
	// user fixes a path the panel pointed them to), invalidate cached
	// detection so the panel re-probes and clears without needing a new chat
	// — matching the Install button's re-detect on success.
	const builtInCommandsKey = [
		settings.claude.command,
		settings.codex.command,
		settings.gemini.command,
		settings.kiro.command,
	].join("\u0000");
	const prevBuiltInCommandsKeyRef = useRef(builtInCommandsKey);
	useEffect(() => {
		if (prevBuiltInCommandsKeyRef.current !== builtInCommandsKey) {
			prevBuiltInCommandsKeyRef.current = builtInCommandsKey;
			// Invalidate the session detection cache (not just the React state)
			// so the re-fired detection effect actually re-probes — otherwise
			// detectAgents() returns the stale once-empty memoized result and
			// the panel never clears.
			plugin.clearAgentDetectionCache();
			setDetectedAgentIds(null);
		}
	}, [builtInCommandsKey, plugin]);

	const gettingStarted = useMemo<GettingStartedInfo | undefined>(() => {
		const currentAgentId =
			session.agentId || plugin.settings.defaultAgentId;
		// Only built-in agents drive the getting-started dead-end state.
		// A custom agent the user configured is never treated as a dead end
		// (I-FRO2): detection covers only the built-ins, so membership alone
		// would wrongly flag every custom-agent default.
		const builtInIds = new Set([
			plugin.settings.claude.id,
			plugin.settings.codex.id,
			plugin.settings.gemini.id,
			plugin.settings.kiro.id,
		]);
		if (
			!shouldShowGettingStarted({
				messageCount: messages.length,
				currentAgentId,
				builtInIds,
				detectedIds: detectedAgentIds,
			})
		) {
			return undefined;
		}
		const installed = detectedAgentIds ?? new Set<string>();
		return {
			detectedAgents: availableAgents.filter((a) => installed.has(a.id)),
			onPickAgent: (agentId: string) => {
				void handleNewChatWithPersist(agentId);
			},
			onOpenSettings: handleOpenSettings,
			onRedetect: () => {
				// I-FRO6: user-initiated re-probe for an agent installed outside
				// the plugin or configured via env only (command unchanged, so the
				// command-key effect never fires) — same invalidate+refetch as the
				// Install-success path below.
				plugin.clearAgentDetectionCache();
				setDetectedAgentIds(null);
			},
			onInstall: async (
				npmPackage: string,
				onOutput: (chunk: string) => void,
			) => {
				const result = await installAgent(npmPackage, { onOutput });
				if (result.ok) {
					// Re-probe: invalidate the session cache AND clear the
					// React state so the detection effect re-runs against a
					// fresh probe — a freshly-installed agent flips the panel
					// and ungates the composer with no reload.
					plugin.clearAgentDetectionCache();
					setDetectedAgentIds(null);
				}
				return result;
			},
		};
	}, [
		messages.length,
		detectedAgentIds,
		session.agentId,
		plugin,
		availableAgents,
		handleNewChatWithPersist,
		handleOpenSettings,
	]);

	// The optimistic pre-ready "Sending…" bubble (pendingMessage) was retired in
	// #82 Decision 9 — a pre-ready message now shows in the locked composer, not
	// the transcript. The transcript is just the real messages.
	// ============================================================
	// A2UI (agent-emitted interactive prompts) — dispatch + context
	// ============================================================
	// Detached send seam (D8): reads live tab state through the same refs the
	// quick-prompt bridge uses, but has NO composer thunks — an action send
	// can never clobber an unsent draft. Enablement is decided by the shared
	// resolver (deriveA2uiTabDispatch), so the rendered control and this port
	// can never disagree (A2UI-I08). On a tab with no live session the action
	// is HELD in the queue-of-one and delivered by the connect-flush, exactly
	// as a composer send on an idle tab — flagged detached so the flush skips
	// the composer clear.
	const a2uiDispatchPort = useMemo(
		() =>
			createSessionDispatchPort({
				lazyState: () => lazyStateRef.current,
				isSending: () => isSendingRef.current,
				isQueued: () => isQueuedRef.current,
				isRestoringSession: () => sessionHistoryLoadingRef.current,
				sendMessage: (text) => handleSendMessageRef.current(text, undefined),
				holdForAcquisition: (text, surfaceId) => {
					queue.dispatch({
						type: "sendWhilePreReady",
						message: { content: text, detachedSurfaceId: surfaceId },
					});
				},
				notify: (message) => {
					new Notice(t("notices.prefixed", { message }));
				},
			}),
		// queue.dispatch is a stable useCallback (handlers read through a ref).
		[queue.dispatch],
	);

	// Transcript projection for the pure surface-state resolvers (role + text).
	const a2uiTranscript = useMemo(
		() =>
			messages.map((m) => ({
				role: m.role,
				text: m.content
					.filter(
						(c) => c.type === "text" || c.type === "text_with_context",
					)
					.map((c) => ("text" in c ? c.text : ""))
					.join("\n"),
			})),
		[messages],
	);

	// Content-stable identities: the maps recompute per message change, but
	// keep their previous identity when the contents are unchanged, so the
	// memoized bubbles don't mass-re-render on every streamed chunk.
	const a2uiAnswersRef = useRef<ReadonlyMap<string, string>>(new Map());
	const a2uiAnswers = useMemo(() => {
		const next = deriveSurfaceAnswers(a2uiTranscript);
		const prev = a2uiAnswersRef.current;
		if (
			prev.size === next.size &&
			Array.from(next).every(([k, v]) => prev.get(k) === v)
		) {
			return prev;
		}
		a2uiAnswersRef.current = next;
		return next;
	}, [a2uiTranscript]);

	const a2uiDefinitionsRef = useRef<
		ReadonlyMap<string, A2uiSurfaceDefinitionSite>
	>(new Map());
	const a2uiDefinitions = useMemo(() => {
		const next = deriveSurfaceDefinitions(a2uiTranscript);
		const prev = a2uiDefinitionsRef.current;
		if (
			prev.size === next.size &&
			Array.from(next).every(([k, v]) => {
				const p = prev.get(k);
				return (
					p !== undefined &&
					p.messageIndex === v.messageIndex &&
					p.surfaceIndex === v.surfaceIndex
				);
			})
		) {
			return prev;
		}
		a2uiDefinitionsRef.current = next;
		return next;
	}, [a2uiTranscript]);

	const a2uiContext = useMemo<A2uiBubbleContext>(
		() => ({
			answers: a2uiAnswers,
			isFirstDefinition: (surfaceId, site) => {
				const first = a2uiDefinitions.get(surfaceId);
				return (
					first !== undefined &&
					first.messageIndex === site.messageIndex &&
					first.surfaceIndex === site.surfaceIndex
				);
			},
			latestSurfaceId: deriveLatestSurfaceId(a2uiDefinitions),
			isSending,
			isQueued: queue.isQueued,
			isRestoringSession: sessionHistory.loading,
			sessionState: lazySession.state,
			// An action held for reconnect owns the surface's pending state, so
			// a released slot (failed reconnect) re-enables it (A2UI-I08).
			heldSurfaceId: queue.pending?.detachedSurfaceId ?? null,
			// Refocus fires at DISPATCH inside the orchestrator — never awaited
			// behind the send promise, which resolves only at turn end (the
			// I173 class; round-1 awaited it and the caret came back minutes
			// late — A2UI-I01).
			onActivate: (surface, button) =>
				activateA2uiButton({
					port: a2uiDispatchPort,
					surfaceId: surface.surfaceId,
					button,
					now: () => new Date().toISOString(),
					refocusComposer: () =>
						scheduleComposerRefocus(containerRef.current),
				}),
		}),
		[
			a2uiAnswers,
			a2uiDefinitions,
			isSending,
			queue.isQueued,
			queue.pending,
			lazySession.state,
			sessionHistory.loading,
			a2uiDispatchPort,
		],
	);

	const displayMessages = messages;

	const messageListElement = (
		<MessageList
			messages={displayMessages}
			isSending={isSending}
			lazyState={lazySession.state}
			isRestoringSession={sessionHistory.loading}
			agentLabel={activeAgentLabel}
			plugin={plugin}
			view={viewHost}
			terminalClient={terminalClientRef.current}
			onApprovePermission={agent.approvePermission}
			hasActivePermission={agent.hasActivePermission}
			isActive={isActive}
			isFallbackRecovery={lazySession.isFallbackRecovery}
			gettingStarted={gettingStarted}
			a2ui={a2uiContext}
		/>
	);

	const contextStripElement = (
		<ContextStrip
			notes={contextNotes.notes}
			isFull={contextNotes.isFull}
			activeNotePath={selectionTracker.activeNotePath}
			activeNoteName={selectionTracker.activeNoteName}
			onAdd={(path, source) => {
				contextNotes.add(path, source);
				focusAfter("context-add");
			}}
			onRemove={(path) => {
				contextNotes.remove(path);
				focusAfter("context-remove");
			}}
			onPillClick={handleContextPillClick}
			onFocusComposer={() => focusComposerAtEnd(composerElRef.current)}
			provisionalPath={computeProvisionalPath({
				settingOn: settings.activeNoteAsDefaultContext,
				suppressed: autoDefaultSuppressed,
				messageCount: messages.length,
				activeNotePath: selectionTracker.activeNotePath,
				committed: contextNotes.notes,
			})}
			onSuppressProvisional={() => {
				setAutoDefaultSuppressed(true);
				focusAfter("suppress-provisional");
			}}
		/>
	);

	// I72 — restored tab whose local message file was missing. Offer
	// on-demand history recovery (agent replay) instead of a silent blank.
	// Auto-hides once a session goes live or any message is shown (recovery
	// succeeded, or the user started typing a fresh conversation).
	const showRecoverableHistory =
		!!historyRecoverable &&
		messages.length === 0 &&
		lazySession.sessionId === null;

	const recoverableHistoryBanner = showRecoverableHistory ? (
		<div className="agent-client-recoverable-history" role="status">
			<span className="agent-client-recoverable-history-text">
				{t("chat.historyBanner.notStored")}
			</span>
			<button
				type="button"
				className="agent-client-recoverable-history-button"
				onClick={() => lazySession.recoverHistory()}
				disabled={lazySession.state === "connecting"}
			>
				{lazySession.state === "connecting"
					? t("chat.historyBanner.reloading")
					: t("chat.historyBanner.reloadFromAgent")}
			</button>
		</div>
	) : null;

	// Slice 3: the in-tab composer reads the SAME deriveComposerAffordances
	// the zero-tab landing does, so the two surfaces cannot drift. For a tab
	// it resolves to session-send (launches:false), in-session quick prompts,
	// and session context; attachments/selectors follow the session's
	// capabilities. InputToolbar keeps its fine per-selector (>1) gating, so
	// showConfigSelectors is the coarse "offer selectors at all" signal and
	// this stays byte-identical.
	const composerAffordances = deriveComposerAffordances({
		surface: "tab",
		capabilities: composerCapabilitiesFromSession(session),
		hasQuickPrompts: quickPrompts.prompts.length > 0,
	});

	const inputAreaElement = (
		<InputArea
			isSending={isSending}
			isSessionReady={isSessionReady}
			lazyState={lazySession.state}
			launches={composerAffordances.sendMode === "launch"}
			isRestoringSession={sessionHistory.loading}
			agentLabel={activeAgentLabel}
			availableCommands={session.availableCommands || []}
			restoredMessage={restoredMessage}
			suggestions={suggestions}
			plugin={plugin}
			view={viewHost}
			composerElRef={composerElRef}
			onSendMessage={async (content, attachments) => {
				sendAndReturnFocus(
					() => handleSendWithLazyAcquisition(content, attachments),
					focusAfter,
				);
			}}
			onStopGeneration={async () => {
				await handleStopWithCancelFlag();
				focusAfter("stop");
			}}
			onRestoredMessageConsumed={handleRestoredMessageConsumed}
			// Queue Next Message (#82)
			isStreaming={isSending}
			isQueued={queue.isQueued}
			// A held DETACHED action (surface click while offline) is not
			// composer text: the banner must not claim the draft is queued, and
			// Delete must not be offered (it emits clearComposer — A2UI-I08).
			isQueuedAction={queue.pending?.detachedSurfaceId !== undefined}
			onQueueMessage={handleQueueMessage}
			onEditQueued={handleEditQueued}
			onDeleteQueued={handleDeleteQueued}
			// Mid-Stream Steering (#81)
			isSteering={queue.isSteering}
			onSteerMessage={handleSteerMessage}
			modes={
				composerAffordances.showConfigSelectors
					? session.modes
					: undefined
			}
			onModeChange={(modeId) => {
				void handleSetMode(modeId);
				focusAfter("set-mode");
			}}
			models={
				composerAffordances.showConfigSelectors
					? session.models
					: undefined
			}
			onModelChange={(modelId) => {
				void handleSetModel(modelId);
				focusAfter("set-model");
			}}
			configOptions={
				composerAffordances.showConfigSelectors
					? session.configOptions
					: undefined
			}
			onConfigOptionChange={(configId, value) => {
				void handleSetConfigOption(configId, value);
				focusAfter("set-config-option");
			}}
			usage={session.usage}
			supportsImages={composerAffordances.showAttachments}
			imageCapabilityKnown={session.promptCapabilities !== undefined}
			agentId={session.agentId}
			// Controlled component props (for broadcast commands)
			inputValue={inputValue}
			onInputChange={(value) => {
				setInputValue(value);
				// Typing-as-intent: feed every keystroke to the lazy
				// session so it can debounce-trigger session acquisition.
				// The hook short-circuits when sessionId is already set
				// (sticky session) so this is cheap on the steady-state
				// path.
				lazySession.onComposerChange(value);
			}}
			attachedFiles={attachedFiles}
			onAttachedFilesChange={setAttachedFiles}
			// Error overlay props
			errorInfo={errorInfo}
			onClearError={handleClearError}
			// Agent update notification props
			agentUpdateNotification={agentUpdateNotification}
			onClearAgentUpdate={handleClearAgentUpdate}
			messages={messages}
			isActive={isActive}
			quickPromptSearchSignal={qpSearchSignal}
			hasQuickPrompts={quickPrompts.prompts.length > 0}
			onRunQuickPrompt={(prompt, gesture, composerAfterStrip) => {
				// QP-I13: a ! picker fire still has the `!query` token in the
				// composer. Sync the composer + its ref (read synchronously by
				// the engine) to the stripped text BEFORE running, so the token
				// doesn't mis-route the fire into the unsent-draft insert and any
				// insert lands in the stripped composer. Chip fires pass no
				// stripped value, so the real composer is used untouched.
				if (composerAfterStrip !== undefined) {
					inputValueRef.current = composerAfterStrip;
					setInputValue(composerAfterStrip);
				}
				quickPrompts.runQuickPrompt(prompt, gesture);
			}}
			onCreateQuickPrompt={(opts) =>
				void plugin.createQuickPromptNote({
					label:
						opts.query.trim() ||
						(opts.body ? deriveLabelFromComposer(opts.body) : ""),
					body: opts.body,
				})
			}
			quickPromptPrompts={matchedQuickPrompts}
			quickPromptHasPendingQueue={queue.isQueued}
		/>
	);

	return (
		<div
			ref={containerRef}
			className="agent-client-chat-view-container"
			style={chatFontSizeStyle}
		>
			{headerElement}
			{cwdBanner}
			{recoverableHistoryBanner}
			{carriedOver ? <CarriedOverPreview data={carriedOver} /> : null}
			{messageListElement}
			{contextStripElement}
			{inputAreaElement}
		</div>
	);
}
