# Agent Console — AI Agent Onboarding Guide

> Read this file before making code changes. It's the authoritative reference for the architecture, data flow, and conventions of this codebase. Applies equally to Copilot, Claude Code, Codex, Gemini, Kiro CLI, or any other AI assistant working on the project.

## Overview

Obsidian plugin for parallel AI agent interaction (Claude Code, Codex, Gemini CLI, Kiro CLI, custom agents) via the Agent Client Protocol (ACP). Optimized for tabbed multi-session UX so users can run several agents at once without losing context.

**Tech**: React 18, TypeScript, Obsidian API, Agent Client Protocol (ACP)

## Repository

| Field        | Value                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Repo         | https://github.com/donivatamazondotcom/obsidian-agent-console                                        |
| Plugin id    | `agent-console`                                                                                      |
| License      | Apache-2.0                                                                                           |
| Maintainer   | Vinod Panicker                                                                                       |
| Forked from  | [RAIT-09/obsidian-agent-client](https://github.com/RAIT-09/obsidian-agent-client) (Apache-2.0)       |

This is a separately-distributed fork that adds tabbed multi-session UX. The codebase is mostly the upstream's, with a tab layer on top and a rebranded plugin identity. See `NOTICE` for full attribution, `RELEASING.md` for the release process, and `CONTRIBUTING.md` for contribution conventions.

## Architecture

```
src/
├── types/                       # Type definitions (no logic, no dependencies)
│   ├── chat.ts                  # ChatMessage, MessageContent, PromptContent, AttachedFile, ActivePermission
│   ├── session.ts               # ChatSession, SessionUpdate (12-type union), SessionInfo, AgentCapabilities (normalized) + RawAgentCapabilities
│   ├── agent.ts                 # AgentConfig, agent settings (Claude/Codex/Gemini/Kiro/Custom)
│   ├── errors.ts                # AcpError, ProcessError, ErrorInfo
│   ├── tab.ts                   # Tab type definitions (TabState, TabIcon, per-tab session ref) + TabSessionState lifecycle union (moved from hooks/ so resolvers/services need no hooks edge)
│   ├── vault.ts                 # NoteMetadata — vault file metadata (moved from services/vault-service so leaf modules need no services edge; re-exported there)
│   ├── title-strategy.ts        # TitleStrategy union + dropdown options (F03 session-title setting)
│   ├── quick-prompt.ts          # QuickPrompt + QuickPromptFileInput (Quick Prompts feature)
│   ├── mcp-auth.ts              # MCP OAuth domain events (McpAuthEvent, PendingMcpAuth) — connection-scoped, dedicated channel
│   ├── picker.ts                # Unified picker view model: PickerItem / PickerInstruction / PickerMarker (view) + ActivePicker / ResolvedPicker / PickerKeyCapabilities (keyboard routing) + PickerSource / PickerState / PickerTriggerContext (Tier 3 state machine) (Unified Picker Control)
│   └── obsidian-internals.d.ts  # Obsidian API declarations not in @types/obsidian
├── acp/                         # ACP protocol (SDK dependency confined here)
│   ├── acp-client.ts            # Process lifecycle, UI-facing API (AcpClient class)
│   ├── acp-handler.ts           # SDK event handler + sessionId filter + listener broadcast
│   ├── mcp-auth-parsers.ts      # Params parsers for _kiro.dev/mcp/* extension notifications (validate at edge)
│   ├── type-converter.ts        # ACP SDK ↔ internal type conversion; capability normalizer (toAgentCapabilities)
│   ├── permission-handler.ts    # Permission queue, auto-approve, Promise resolution
│   └── terminal-handler.ts      # Terminal process create/output/kill
├── i18n/                        # UI string localization boundary ([[Agent Console I18N]])
│   ├── index.ts                 # t(key, params) + initLocale + resolveLocale; locale resolved once at load (getLanguage or the Advanced language override)
│   ├── en.ts                    # Canonical English catalog (the key contract; as const)
│   ├── ko.ts                    # Korean catalog (factory-wrapped, partial, per-key English fallback)
│   ├── ja.ts                    # Japanese catalog (factory-wrapped, partial, per-key English fallback)
│   └── zh.ts                    # Simplified Chinese catalog (factory-wrapped, partial, per-key English fallback)
├── services/                    # Business logic (non-React, no React imports)
│   ├── vault-service.ts         # Vault access + fuzzy search + CM6 selection tracking
│   ├── context-builder.ts       # Builds prompt context from crystallized notes
│   ├── context-validator.ts     # Context-note data-model invariant enforcement (parse-at-edge)
│   ├── replayContextBuilder.ts  # Reconstructs replay context for restored sessions
│   ├── session-metadata.ts      # Session metadata write resolution (history entry on turn-end) + title-precedence resolver (deriveSessionRecordTitle)
│   ├── session-search.ts        # Pure full-text search engine over saved sessions (extract/index/match/snippet)
│   ├── settings-migration.ts    # One-time settings migration (autoMentionActiveNote → activeNoteAsDefaultContext)
│   ├── settings-service.ts      # Reactive settings store (observer pattern only)
│   ├── session-storage.ts       # Session metadata + message file I/O (sessions/*.json)
│   ├── session-store.ts         # Single serialized writer of record for savedSessions metadata/title (I114)
│   ├── mcp-auth-manager.ts      # Single owner of pending MCP sign-in state + queue-aware Notice lifecycle
│   ├── settings-normalizer.ts   # Validation helpers + DEFAULT_SETTINGS + normalizeRawSettings (raw→typed mapping)
│   ├── session-helpers.ts       # Agent config building, API key injection (pure functions)
│   ├── agent-detection.ts       # First-run agent detection (probe commands) + default-by-priority selection (pure)
│   ├── agent-installer.ts       # In-plugin agent install (first-run): one-line npm -g install via login-shell PATH; summarizeInstallFailure → guidance
│   ├── agent-packages.ts        # Built-in agent install metadata (npm package, docs setup slug, install-command form) — single source of truth
│   ├── session-state.ts         # Session state updates (legacy mode/model, config restore)
│   ├── message-state.ts         # Message array transforms (upsert, merge, streaming apply)
│   ├── message-sender.ts        # Prompt preparation + sending (pure functions)
│   ├── carried-over-preview.ts  # Cross-agent carry-over preview builder (pure)
│   ├── carry-over-builder.ts    # Cross-agent carry-over transcript + content blocks (pure)
│   ├── chat-exporter.ts         # Markdown export with frontmatter
│   ├── view-registry.ts         # Multi-view management, focus, broadcast
│   ├── register-chat-view.ts    # I157: guarded chat-view registration — a duplicate-view-type collision degrades to a notice, not an onload crash
│   ├── run-registrations.ts     # I157: onload resilience harness — runs each registration isolated so one failure can't abort the whole load
│   ├── migrate-legacy-view-type.ts # I157: lossless in-place re-home of panels persisted under the legacy "agent-client-chat-view" type (skipped when Agent Client owns it)
│   ├── session-dispatch-port.ts # Detached composer-independent send seam (canSendNow via ready+idle gate; a2ui actions dispatch here, never fireOrQueue)
│   ├── recently-closed-stack.ts # F13 undo-close: closed-tab record + LIFO push/pop/build (pure)
│   ├── message-queue-logic.ts   # #82 queue-of-one pure decisions: queue/flush/Enter-action/broadcast-skip
│   ├── queue-orchestration-reducer.ts # #82 dispatch-owning single-slot reducer: (state,event)->{state,effects}; flush is raw-by-construction (closes Q4)
│   ├── quick-prompts-logic.ts   # Quick Prompts pure logic: parse/label/slug-id/folder-scope/{{selection}}-resolve + the browser-true 2×2 action decision (where × commitment: fire/queue/insert/disabled/new-tab + foreground) + tag matching + launcher helpers (capRestingChips / parseQuickPromptTrigger / stripQuickPromptTrigger / rankLauncherPrompts)
│   ├── picker-source-configs.ts # The three PickerSource configs (mention/slash/quick-prompt) that drive usePicker — all variance as pure, dependency-injected config (moved from utils/: it wires domain services, so it lives in the services layer; utils is a shared leaf)
│   ├── quick-prompts.ts         # QuickPromptLibrary (scan/watch/reconcile) + VaultQuickPromptSource adapter
│   ├── update-checker.ts        # Agent/plugin version checking
│   ├── net.ts                   # The ONLY module permitted outbound network I/O (fixed ALLOWED_HOSTS; egress tripwire enforces it)
│   ├── a2ui/                    # A2UI buttons-v0 trust boundary (agent-emitted interactive prompts)
│   │   ├── spec-snapshot.ts     # Frozen A2UI v1.0-candidate profile constants (version, catalog ids, component allowlist, limits)
│   │   ├── types.ts             # Fence candidate + validated-surface tagged unions (literal-only component model)
│   │   ├── fence-extractor.ts   # ```a2ui fence extraction from markdown; nesting-safe, streaming-aware (open fences stay inert)
│   │   ├── segmenter.ts         # Assistant-message segmentation (markdown | a2ui-surface) upstream of MarkdownRenderer; lossless (segments rebuild the text)
│   │   ├── action.ts            # v1.0 action envelope + sent user message + payload-derived display summary (label is decoration)
│   │   ├── surface-state.ts     # Pure resolvers: answered state from transcript (restore/replay); idle-only action enablement
│   │   ├── activate.ts          # Button-activation orchestration: refocus fires at DISPATCH time, not turn-end (A2UI-I01)
│   │   ├── capability.ts        # D9 ACP-init capability advertisement for the a2ui binding (a2uiClientCapabilities under namespaced _meta)
│   │   └── validator.ts         # Total no-throw envelope/profile/graph/limits validation (probe checks V02–V14)
│   ├── import/                   # Cross-plugin settings-import adapters
│   │   ├── ImportSource.ts       # ImportSource interface + preview types
│   │   ├── agentClientAdapter.ts # Reads agent-client data.json → normalizeRawSettings → slice
│   │   └── registry.ts           # createImportSources(deps) — available sources (agent-client)
│   └── __benchmarks__/          # Perf-gate (Gate B-v1) throughput benchmarks
│       ├── context-builder.bench.ts    # context-builder throughput benchmark
│       └── context-validator.bench.ts  # context-validator throughput benchmark
├── hooks/                       # React custom hooks (state + logic)
│   ├── useAgent.ts              # Facade: composes useAgentSession + useAgentMessages
│   ├── useLazySession.ts        # Typing-as-intent session lifecycle (debounce + queued send)
│   ├── useQueueOrchestration.ts # #82 React adapter over queueOrchestrationReducer: owns the pending slot, runs effects (acquire / flushDispatch=raw / clearComposer)
│   ├── useTabPersistence.ts     # Save/restore per-leaf tab state across restarts
│   ├── useTabSessionState.ts    # Six-state per-tab session state machine
│   ├── useRestoredMessages.ts   # Replay transcript for restored tabs with no live session
│   ├── loadExistingSessionFlow.ts # Restored-tab reconnect flow (lazy resume on first keystroke)
│   ├── reloadSessionFlow.ts     # Pure soft-reload orchestration (resume same session / fresh fallback)
│   ├── useDebouncedSessionSave.ts # Debounced session persistence (messages + context notes)
│   ├── useContextNotes.ts       # Crystallized context-note state per chat (add/remove/seen)
│   ├── useContextVaultEvents.ts # Vault rename/delete sync for crystallized context notes
│   ├── useSelectionTracker.ts   # Editor selection capture for the context strip
│   ├── useAgentSession.ts       # Session lifecycle, config options, optimistic updates
│   ├── useAgentMessages.ts      # Message state, streaming (RAF batch), permissions
│   ├── useSuggestions.ts        # Thin source wiring: runs usePicker per source (mention/slash/quick-prompt), adapts to the mentions/commands/quickPrompts contract + the Tier-2 activePicker (Unified Picker Control Tier 3)
│   ├── usePicker.ts             # One generic suggestion-picker state machine driven by a PickerSource: items/selection/open, clamp-vs-wrap nav, async/sync fetch, dismiss guard (Unified Picker Control Tier 3)
│   ├── useSessionHistory.ts     # Session list/load/resume/fork
│   ├── useSessionSearch.ts      # Session search state: query debounce + lazy content index
│   ├── useChatActions.ts        # Business callbacks (send, newChat, export, restart, etc.)
│   ├── useHistoryModal.ts       # Session history modal lifecycle
│   ├── useLandingHistoryModal.ts # View-level Local-only session-history modal opener for the zero-tab landing (no ChatPanel host); restore/fork route through openSessionInTab
│   ├── useComposerFocusReturn.ts # Return focus to composer after in-panel state changes (guarded by composer-cluster focus)
│   ├── useSettings.ts           # Settings subscription (useSyncExternalStore)
│   ├── useRecentlyClosedTabs.ts # F13 undo-close: per-leaf in-memory recently-closed stack
│   ├── useMessageQueue.ts       # #82 queue-of-one: runtime-only next-message slot (auto-sends on turn end)
│   ├── useQuickPrompts.ts       # Quick Prompts: live list + guarded runQuickPrompt (fire/insert/queue via the pure engine)
│   └── useTabManager.ts         # Per-tab session orchestration (state, focus, lifecycle)
├── ui/                          # React components
│   ├── ChatContext.ts           # React Context (plugin, acpClient, vaultService, settingsService)
│   ├── ContextStrip.tsx         # Context-note strip (crystallized pills + type-to-add)
│   ├── LossyFallbackNotice.tsx  # Notice when a restored tab continues from transcript only
│   ├── CarriedOverPreview.tsx   # Read-only carried-over conversation block (agent switch)
│   ├── ConfirmSessionIntentModal.ts # Confirm-before-clearing modal (switch / new-chat / hard-reload)
│   ├── CorruptionRecoveryModal.ts # Corrupt persisted-state recovery modal
│   ├── ConfirmCloseModal.ts     # Confirm-before-closing-panel modal (focused Cmd+W with 2+ tabs)
│   ├── ConfirmResetModal.ts     # Confirm-before-resetting the Obsidian system prompt (only when typed text would be lost)
│   ├── branding.ts              # Agent Console SVG mark + cross-surface branding
│   ├── ChatPanel.tsx            # Orchestrator: calls hooks, workspace events, rendering
│   ├── ChatView.tsx             # Sidebar view (ItemView wrapper)
│   ├── chat-view-type.ts        # I157: namespaced "agent-console-chat-view" view-type constant (avoids collision with upstream Agent Client)
│   ├── TabBar.tsx               # Tab bar UI for parallel agent sessions (drag-reorder, +button, status icons)
│   ├── TabErrorBoundary.tsx     # Per-tab React error boundary with Retry
│   ├── ZeroTabLanding.tsx       # Zero-tab landing screen shown when every tab is closed (minimal placeholder in Slice 1; reason-tagged empty-state shell in Slice 2)
│   ├── ChatHeader.tsx           # Header (sidebar chat view)
│   ├── MessageList.tsx          # Message list (native browser scroll, content-visibility:auto for off-screen render skipping)
│   ├── A2uiSurfaceHost.tsx      # Agent-emitted buttons-v0 surface host: validate-at-edge, native buttons, resolver-gated enablement, inert fallback
│   ├── MessageBubble.tsx        # Single message rendering (content dispatch, copy button)
│   ├── ToolCallBlock.tsx        # Tool call + diff display (word-level highlighting)
│   ├── TerminalBlock.tsx        # Terminal output polling
│   ├── InputArea.tsx            # Textarea, attachments, mentions, history
│   ├── composer-focus-tracker.ts # Pure composer-cluster focus reducer + classifier (focus-return guardrail)
│   ├── InputToolbar.tsx         # Config/mode/model selectors, usage, send button
│   ├── SuggestionPopup.tsx      # Unified suggestion picker: one PickerItem render path for mention / slash / quick-prompt (! trigger) + pinned instruction footer
│   ├── PermissionBanner.tsx     # Permission request buttons
│   ├── McpAuthBanner.tsx        # Inline re-auth affordance under auth-failed tool calls
│   ├── McpAuthModal.ts          # "Re-authenticate MCP servers" picker + confirm-gated reconnect modal
│   ├── ErrorBanner.tsx          # Error/notification overlay
│   ├── SessionHistoryModal.tsx  # Session history modal (Local/Agent source toggle, per-row agent badge, search, confirm delete, migration empty-state, disconnected-Agent sync affordance)
│   ├── session-intent-confirm.ts # SEAM (Track 1↔2): shared confirm/carry-over modal interface — Track 2 owns the component, Track 1 defines the contract
│   ├── ChangeDirectoryModal.ts  # Per-tab cwd change modal (sets working dir for agent process)
│   ├── ChooseQuickPromptFolderModal.ts # First-creation folder prompt: pick where quick prompts live (Slice 6)
│   ├── ImportSettingsModal.ts  # Cross-plugin settings-import preview + apply dialog
│   ├── AgentPickerModal.ts      # FuzzySuggestModal agent picker for "New chat with agent…"
│   ├── QuickPromptBar.tsx       # Ephemeral contextual quick-prompt chips row above the composer
│   ├── quick-prompt-bridge.ts   # createQuickPromptBridge factory: composer/queue/selection state + fire/queue/insert/new-tab effects for the engine (fireOrQueue returns focus to the composer, QP-I20)
│   ├── RenamePromptModal.ts    # Rename a quick prompt's pill label (chip context menu → Rename)
│   ├── SettingsTab.ts           # Plugin settings UI
│   ├── SharedLinksButton.tsx    # Header shared-links indicator (count badge + grouped New/Earlier popover)
│   ├── view-host.ts             # IChatViewHost interface
│   ├── use-auto-scroll-pin.ts   # Auto-scroll-to-bottom hook (pin state + native scroll + ResizeObserver/wheel/touch)
│   ├── use-pill-open-scope.ts   # Active-tab + focus-gated keymap scope to open focused context pills on Enter combos (I156; focus gate I161)
│   ├── use-auto-scroll-pin.types.ts  # PinState, params, result types for useAutoScrollPin
│   └── shared/
│       ├── IconButton.tsx       # Icon button + Lucide icon wrapper
│       ├── MarkdownRenderer.tsx # Obsidian markdown rendering
│       ├── AttachmentStrip.tsx  # Attachment preview strip
│       └── useTooltip.ts        # attachTooltip / tooltipRef / useTooltip — the ONE sanctioned way to attach a tooltip; wraps Obsidian setTooltip (whose mechanism IS aria-label), composes visible label + reason via deriveTooltipText so the accessible name keeps the visible text (WCAG 2.5.3), and clears a stale tooltip. The DOM `title` attribute is an ESLint error (I199)
├── resolvers/                   # Pure decision functions (derive*/decide*) — no React/Obsidian/SDK imports; exhaustive switches (resolver-zone.test.ts)
│   ├── a2ui-dispatch.ts            # deriveA2uiTabDispatch — pure tab-level resolver for what activating an interactive-surface control does (sendNow / acquireAndSend / refuse+reason); read by BOTH the surface renderer (via deriveSurfaceActionAffordance) and SessionDispatchPort so an enabled button always has a dispatchable port; gates on intent, not connection state (A2UI-I08)
│   ├── agent-picker-options.ts     # deriveAgentPickerOptions — pure landing agent-picker resolver (detection-gated, default-first, shown only on a real choice)
│   ├── agent-switch.ts             # Switch a lazy tab's agent so the first message connects to the switched agent
│   ├── composer-affordances.ts     # deriveComposerAffordances — pure composer send-target + control-composition resolver (surface × composer-caps × hasQuickPrompts → sendMode/quickPromptFire/context/showAttachments/showConfigSelectors); connection-state-independent (does NOT read lazyState); shared by the landing + in-tab composer so they can't drift; layers with deriveSendAffordance (enablement) — no overlap
│   ├── composer-focus.ts           # Focus composer textarea + caret at end (restored-draft mount, TP-I03); send→refocus timing seam (I173)
│   ├── deriveTabLabel.ts           # Derive tab label from session / first message
│   ├── empty-state-view.ts         # deriveEmptyStateView — pure empty-state affordance resolver (location × hasDetectedAgent → reason + redetect/installRows/agentPicks/landingActions/settings/hint); shared by GettingStarted (in-tab) and the zero-tab landing so the two can't drift
│   ├── header-slot.ts              # deriveHeaderSlot — pure 4-way header secondary-slot resolver (model / connecting / idle / none)
│   ├── notify-gate.ts              # shouldNotifySystem — pure resolver: should an OS notification fire for a backgrounded panel; gates on the flush signal, not an instantaneous focus read (I168)
│   ├── resolveInitialAgentId.ts    # Pure: agent a fresh (non-restored) tab opens on — Default agent when restore-tabs is off (TP-I05)
│   ├── send-affordance.ts          # Pure send-enablement resolver (deriveSendAffordance → canSend/buttonDisabled/reason) + isSessionLive; single source for ChatPanel/InputArea/InputToolbar/MessageList/broadcast
│   ├── session-history-view.ts     # Pure session-history gating resolver (deriveSessionHistoryView(caps, isAgentReady, hasLocalData, source) → listSource/agentViewAvailable/showFilters/restore/fork/banner); toggle-driven source defaults to Local for every agent; gates on data+intent, not connection (supersedes I09/I41 + filter facet)
│   ├── tab-label-width.ts          # deriveActiveTabLabelMax — pure resolver for the active tab's label max-width so the whole active tab stays visible in the strip
│   ├── tab-scroll.ts               # deriveTabScrollLeft — pure resolver for the horizontal scrollLeft that keeps the active tab in view on tab-change and strip resize (TS-I07)
│   ├── tab-state.ts                # deriveTabState — pure tab-icon-state resolver (lifecycle × isSending × hasActivePermission → ready/busy/permission/error/disconnected); gates busy on intent, not a connect-edge, so a lazy first-send or mid-turn permission can't strand the icon (I172)
│   └── tooltip-text.ts             # deriveTooltipText — pure tooltip-text resolver ({visibleLabel, reason, separator} → tagged union text/none); owns the label-in-name composition and models "clear the stale tooltip" as a real outcome. Separator is an input because punctuation is localized (I199)
├── utils/                       # Shared utilities (pure functions)
│   ├── platform.ts              # Shell, WSL, Windows env, command building
│   ├── close-confirm.ts         # Pure shouldConfirmClose predicate for the multi-tab close gate
│   ├── chat-scope-parent.ts     # Pure resolver: parent chat-UI pushed scopes to the view scope so Cmd+W reaches the close guard (I155)
│   ├── focus-scoped-push.ts     # Push a chat-UI keymap scope onto the global keymap only while the panel is focused; pop on blur so Cmd+W can't leak to the close guard from other leaves (I161)
│   ├── activeNoteGrabToggle.ts  # Grab/ungrab active note in context strip (hotkey)
│   ├── provisional-context.ts   # Provisional auto-default context pill (crystallize-on-send)
│   ├── image-paste.ts           # classifyImagePaste — pure image-paste decision (connecting vs unsupported; separates unknown from false)
│   ├── titleMarker.ts           # F03: parse/strip <title>…</title> from the head of the first reply (parseLeadingTitle + TitleHeadBuffer)
│   ├── system-instructions.ts   # First-message system-instruction constants + sentinels (injected by message-sender; stripped by deriveTabLabel)
│   ├── host-context-briefing.ts # Compose the Obsidian host-context briefing (per-block selection + cwd-in-vault gate) injected on first message; folds in the system-instruction hints
│   ├── obsidian-system-prompt.ts # Pure composer of the Obsidian system-prompt briefing (host identity / rendering / cwd / vault-collab blocks) injected on first message
│   ├── toolCallSummary.ts       # One-row tool-call summary derivation
│   ├── toolCallDiff.ts          # Pure unified-diff computation shared by ToolCallBlock + the line-count badge
│   ├── args.ts                  # Forgiving Arguments-field parse/format (shell-tokenize spaces+newlines, round-trip quoting) — I162
│   ├── paths.ts                 # Path resolution, file:// URI
│   ├── error-utils.ts           # ACP error conversion
│   ├── mention-parser.ts        # @[[note]] detection/extraction
│   ├── picker-sources.ts        # Pure projections of mentions / slash / quick-prompts into the unified PickerItem model + per-source footer instructions (Unified Picker Control)
│   ├── slash-command-logic.ts   # Pure / trigger detection (start-of-line only) + command filtering (Unified Picker Control Tier 3)
│   ├── link-leaf.ts             # Resolve click modifiers → Obsidian leaf/pane (Keymap.isModEvent) for internal links
│   ├── quick-prompt-gesture.ts  # Map a click/keypress → the Quick Prompts 2×2 gesture (openElsewhere/foreground/insert) via Keymap.isModEvent + shift/alt
│   ├── link-extract.ts          # Derive per-tab shared-link set from messages (Shared Links Bubble) + new/old classification
│   ├── notification-content.ts  # buildCompletionNotificationContent — pure turn-end notification title/body/tag (tab label in title)
│   ├── notification-click.ts    # Pure orchestrator for a completion-notification click (reveal owning leaf/window + switch to producing tab); I52 recurrence
│   ├── notification-registry.ts # Retains OS Notification objects so their onclick survives GC until user/OS dismissal (I52)
│   ├── update-flush-scheduler.ts # createUpdateFlushScheduler — visibility-immune session-update flush (rAF stalls in backgrounded windows) (I168)
│   ├── menu-registry.ts         # Tracks open Menu popups; closes them on plugin unload (reload-safety)
│   ├── mcp-auth-affordance.ts   # Pure resolver: auth-failed tool call → inline re-auth affordance decision
│   ├── command-palette.ts       # Pure start-a-chat + context-gating decisions (computeStartChat, isChatCommandAvailable)
│   ├── tab-agent-invariant.ts   # Pure fail-loud invariant: a tab's live session agent == its selected agent
│   ├── restored-tab-content.ts  # resolveSeededMessages/ContextNotes — single resolver for a tab's seeded transcript+notes (restore | fork | startup-restore)
│   ├── format-session-title.ts  # Pure display-formatter for session-history titles (renders markdown links/wikilinks to readable text, collapses whitespace; no truncation — CSS owns width); used by SessionHistoryModal, carries into HistoryRow
│   ├── folder-picker.ts         # Shared Electron native folder picker (modal + settings Browse)
│   ├── working-directory.ts     # Resolve/validate the default working directory for new chats
│   ├── agent-expansion.ts       # Per-session expand/collapse state for settings agent sections
│   ├── settings-layout.ts       # Pure settings-pane layout resolvers (deriveImportPlacement(hasCompletedSetup) → top-matter | advanced; D5)
│   ├── textarea-autosize.ts     # decideTextareaResize/clampTextareaHeight — pure composer auto-resize (avoids scroll-pin jump, I-S13)
│   └── logger.ts                # Debug-mode logger
├── __test_stubs__/              # Test-only Obsidian/jsdom shims (not shipped)
│   ├── obsidian.ts              # Obsidian module stub for vitest
│   └── vitest.setup.ts          # jsdom setup: activeDocument/activeWindow + HTMLElement.setCssProps shims
├── plugin.ts                    # Obsidian plugin lifecycle, settings persistence
└── main.ts                      # Entry point
```

## Data Flow

### ACP Event Flow (single path)
```
Agent Process → ACP SDK → AcpHandler (sessionId filter) → listeners broadcast
  → useAgentSession (session-level: commands, mode, config, usage, error)
  → useAgentMessages (message-level: text chunks, tool calls, plan)
  → useAgent (facade, 1 onSessionUpdate subscription)
```

All events flow through a single `onSessionUpdate` channel. No special paths for permissions or errors.

### Permission Flow
```
Agent requestPermission → PermissionManager.request() → onSessionUpdate (tool_call)
User clicks approve/reject → PermissionManager.respond() → onSessionUpdate (tool_call_update)
```

## Key Components

### ChatPanel (`ui/ChatPanel.tsx`)
Central orchestrator component.
- **Hook Composition**: Calls useAgent, useSuggestions, useSessionHistory, useChatActions, useHistoryModal, useSettings
- **Workspace Events**: Handles hotkeys via ref pattern (stable event registration)
- **Callback Registration**: IChatViewContainer callbacks via refs
- **Rendering**: Renders ChatHeader, MessageList, InputArea directly

ChatPanel does NOT route session updates — that's handled internally by useAgent.

### ChatView (`ui/ChatView.tsx`)
Thin wrapper that:
- Create services (AcpClient, VaultService) in lifecycle methods
- Provide ChatContext (plugin, acpClient, vaultService, settingsService)
- Render `<ChatPanel />`
- Implement IChatViewContainer for broadcast commands

### Hooks (`hooks/`)

**useAgent** (facade): Comp훈oses useAgentSession + useAgentMessages
- Single `onSessionUpdate` subscription
- Unified `handleSessionUpdate` dispatches to both sub-hooks
- Return is `useMemo`-wrapped for referential stability

**useAgentSession**: Session lifecycle + config
- `createSession()`: Build config, inject API keys, initialize + newSession
- `setConfigOption()`: Optimistic update + rollback on error
- `setMode()` / `setModel()`: Legacy API (deprecated, still used by many agents)
- Session-level update handler (commands, mode, config, usage, process_error)
- Uses `sessionRef` pattern to stabilize callback deps

**useAgentMessages**: Messaging + streaming + permissions
- `sendMessage()`: Prepare (auto-mention, path conversion) → send via AcpClient
- RAF batching: streaming updates accumulated per-frame via `requestAnimationFrame`
- Tool call index: `Map<string, number>` for O(1) upsert
- `ignoreUpdatesRef`: suppresses history replay during session/load
- Permission: `activePermission` (useMemo derivation), approve/reject callbacks

**useSuggestions**: @mention + /command (unified)
- Mention detection, note searching, dropdown interaction
- Slash command filtering and selection
- Auto-mention toggle coordination (slash commands disable auto-mention)
- Return is `useMemo`-wrapped (mentions + commands objects)

**useChatActions**: Business callbacks
- handleSendMessage, handleNewChat, handleExportChat, handleRestartAgent, etc.
- Uses individual method deps (not whole agent object) for stability
- Owns restoredMessage and agentUpdateNotification state

**useSessionHistory**: Session persistence
- `restoreSession()`: Load/resume with local message fallback
- `forkSession()`: Create new branch from existing session
- 5-minute cache with invalidation
- Return is `useMemo`-wrapped

**useHistoryModal**: Modal lifecycle
- Lazy modal creation, props synchronization
- Session operation callbacks (restore, fork, delete)

### ACP Client (`acp/acp-client.ts`) + ACP Handler (`acp/acp-handler.ts`)

**AcpClient** — UI-facing API and process lifecycle:
- spawn() with login shell, JSON-RPC via ndJsonStream
- initialize() → newSession() → sendPrompt() → cancel() → disconnect()
- Session management: listSessions, loadSession, resumeSession, forkSession
- Owns PermissionManager, TerminalManager, AcpHandler
- `currentSessionId` set before `await` in loadSession/resumeSession to prevent replay filtering
- Single exit point: `onSessionUpdate` (multiple listeners via Set)

**AcpHandler** — SDK event receiver:
- sessionUpdate: converts ACP types → domain types → broadcast to listeners
- sessionId filter: only emits updates matching `currentSessionId`
- requestPermission → PermissionManager
- Terminal operations → TerminalManager

### Services (`services/`)

**VaultService**: Vault access + file index + fuzzy search + CM6 selection tracking
**SettingsService**: Reactive settings store (observer pattern for useSyncExternalStore). Session storage delegated to SessionStorage.
**SessionStorage**: Session metadata CRUD (in plugin settings) + message file I/O (sessions/*.json)
**settings-normalizer**: Validation helpers (str, bool, num, enumVal, obj, strRecord, xyPoint) + toAgentConfig + parseChatFontSize + DEFAULT_SETTINGS + normalizeRawSettings (the single raw→typed settings mapping, shared by loadSettings and the import adapter)
**import/**: Cross-plugin settings migration. ImportSource interface + agentClientAdapter (reads the upstream agent-client data.json, reuses normalizeRawSettings, ports API keys by reference or migrates legacy plaintext) + registry (createImportSources).
**session-helpers**: Pure functions — buildAgentConfigWithApiKey, findAgentSettings, getAvailableAgents
**agent-detection**: Pure functions — detectAvailableAgents (parallel command probes via injected resolver), pickDefaultAgentId / chooseFirstRunDefault (priority-ordered first-run default). Used by plugin.detectAgents() (session-cached) for first-run default selection and the getting-started empty state.
**session-state**: Pure functions — applyLegacyValue, tryRestoreConfigOption, restoreLegacyConfig
**message-state**: Pure functions — applySingleUpdate, applyUpsertToolCall, mergeToolCallContent, findActivePermission, selectOption
**message-sender**: Pure functions — preparePrompt (embedded context vs XML text, shared helpers), sendPreparedPrompt (auth retry)

## Types

### SessionUpdate (`types/session.ts`)
Union type for all session update events from the agent:

```typescript
type SessionUpdate =
  | AgentMessageChunk        // Text chunk from agent's response
  | AgentThoughtChunk        // Text chunk from agent's reasoning
  | UserMessageChunk         // Text chunk from user message (session/load)
  | ToolCall                 // New tool call event
  | ToolCallUpdate           // Update to existing tool call
  | Plan                     // Agent's task plan
  | AvailableCommandsUpdate  // Slash commands changed
  | CurrentModeUpdate        // Mode changed
  | SessionInfoUpdate        // Session metadata changed
  | UsageUpdate              // Context window usage
  | ConfigOptionUpdate       // Config options changed
  | ProcessErrorUpdate;      // Process-level error (spawn failure, command not found)
```

### Key Interfaces

```typescript
// services/vault-service.ts
interface IVaultAccess {
  readNote(path: string): Promise<string>;
  searchNotes(query: string): Promise<NoteMetadata[]>;
  getActiveNote(): Promise<NoteMetadata | null>;
  listNotes(): Promise<NoteMetadata[]>;
}

// services/settings-service.ts
interface ISettingsAccess {
  getSnapshot(): AgentClientPluginSettings;
  updateSettings(updates: Partial<AgentClientPluginSettings>): Promise<void>;
  subscribe(listener: () => void): () => void;
  // Session storage methods (delegated to SessionStorage internally)
  saveSession(info: SavedSessionInfo): Promise<void>;
  getSavedSessions(agentId?: string, cwd?: string): SavedSessionInfo[];
  deleteSession(sessionId: string): Promise<void>;
  saveSessionMessages(sessionId: string, agentId: string, messages: ChatMessage[]): Promise<void>;
  loadSessionMessages(sessionId: string): Promise<ChatMessage[] | null>;
  deleteSessionMessages(sessionId: string): Promise<void>;
}
```

## Development Rules

### Architecture
1. **useAgent as facade**: Composes useAgentSession + useAgentMessages. ChatPanel calls useAgent, not sub-hooks directly.
2. **Services have zero React imports**: Pure functions and classes in `services/`. No useState, useCallback, React.Dispatch, etc.
3. **ACP isolation**: All `@agentclientprotocol/sdk` imports confined to `acp/`. AcpClient is UI-facing, AcpHandler is SDK-facing.
4. **Types have zero deps**: No `obsidian`, no SDK, no React in `types/`
5. **Single event channel**: All agent events (messages, session updates, permissions, errors) flow through `onSessionUpdate`. No special callback paths.
6. **Context for services**: plugin, acpClient, vaultService, settingsService via ChatContext
7. **Decision functions live in `resolvers/`**: a new `derive*`/`decide*` goes in `src/resolvers/` — that zone bans React/Obsidian/SDK imports and requires strictly exhaustive switches with no `default`. Writing one outside it fails `src/__tests__/resolver-zone.test.ts` unless grandfathered there with a reason.

### Performance Patterns
1. **useMemo for return stability**: useAgent, useSuggestions, useSessionHistory wrap return objects in useMemo to prevent cascading re-renders
2. **sessionRef pattern**: useAgentSession stores session in useRef for callback access without adding session to deps
3. **Individual method deps**: useChatActions uses `agent.sendMessage` not `agent` as deps — prevents callback recreation when unrelated state changes
4. **Workspace event refs**: ChatPanel stores event handler callbacks in refs, keeping useEffect deps minimal
5. **RAF batching**: useAgentMessages batches streaming updates per animation frame (~60fps) instead of per-chunk
6. **React.memo**: MessageBubble, ToolCallBlock, TerminalBlock wrapped for skip-render optimization
7. **Native scroll + content-visibility**: MessageList uses native browser scroll with `content-visibility: auto` on each bubble for off-screen render skipping; auto-scroll-to-bottom logic lives in `useAutoScrollPin` (modeled on `use-stick-to-bottom`)
8. **O(1) tool call index**: Map<string, number> for tool call upsert without linear scan

### Obsidian Plugin Review (CRITICAL)
1. No innerHTML/outerHTML - use createEl/createDiv/createSpan
2. NO detach leaves in onunload (antipattern)
3. Styles in CSS only - no JS style manipulation
4. Use Platform interface - not process.platform
5. Minimize `any` - use proper types

### Accessibility — keyboard-first (enforced)

Every interactive element must be operable by keyboard alone. This is a design principle, not just a lint checkbox — the keyboard is a first-class input device in Agent Console (alongside "mirror the browser").

`eslint-plugin-jsx-a11y` enforces this on all `**/*.tsx` files (added in #92). Four rules, all errors — a PR that adds interactive UI fails CI if it trips them:

- `jsx-a11y/click-events-have-key-events` — an `onClick` needs a matching `onKeyDown`/`onKeyUp`/`onKeyPress`.
- `jsx-a11y/no-static-element-interactions` — a non-interactive element (`<div>`, `<span>`) with a handler needs a `role`.
- `jsx-a11y/no-noninteractive-element-interactions` — same for elements with a non-interactive ARIA role.
- `jsx-a11y/interactive-supports-focus` — an element with an interaction handler must be focusable (`tabIndex`).

Satisfy them (preferred -> fallback):

1. Use a native `<button>`/`<a>`/`<input>` — keyboard activation and focus are free.
2. If a `<div>`/`<span>` must be the control, add `role="button"` (or the right role), `tabIndex={0}`, and an `onKeyDown` firing the same action on Enter/Space.
3. Keep a visible `:focus-visible` indicator — never suppress it without an equivalent cue.

Scope: `.tsx` (React components) only. Node tooling under `tools/` and non-component `.ts` are out of scope.

### Cross-platform (macOS, Windows, Linux) — enforced

Agent Console runs on all three desktop platforms. Shared code must not bake in macOS assumptions.

- **Modifier/key hints** — route every user-facing key label through `MOD_KEY` / `ALT_KEY` / `SHIFT_KEY` / `ENTER_KEY` / `modCombo` in `utils/platform.ts`. On macOS these render the glyphs (⌘ ⌥ ⇧ ↵); on Windows/Linux they render `Ctrl` / `Alt` / `Shift` / `Enter`. NEVER hardcode a Mac glyph in a string — a CI ESLint rule (`no-restricted-syntax`, added with I134) fails the build on `⌘`/`⌥`/`⇧`/`⌃` in any `src/` string literal except `platform.ts` (the single source) and tests. This mirrors the gesture *behavior*, which already routes through Obsidian's `Keymap.isModEvent` / `Mod` (Ctrl on non-Mac).
- **Paths / shells / env** — use `utils/platform.ts` (`prepareShellCommand`, WSL wrappers, Windows registry PATH); never `process.platform` or hardcoded `/bin/zsh`-style assumptions.
- **Copy** — no macOS-only menu paths or examples in user-facing text.

### Naming Conventions
- Types: `kebab-case.ts` in `types/`
- ACP: `kebab-case.ts` in `acp/`
- Services: `kebab-case.ts` in `services/`
- Hooks: `use*.ts` in `hooks/`
- Components: `PascalCase.tsx` in `ui/`
- Utils: `kebab-case.ts` in `utils/`

### Code Patterns
1. React hooks for state management
2. useCallback/useMemo for performance (see Performance Patterns above)
3. useRef for cleanup function access and stale closure prevention
4. Error handling: try-catch async ops
5. Logging: Logger class (respects debugMode). Avoid excessive per-keystroke logging.
6. **Upsert pattern**: Use `setMessages` functional updates to avoid race conditions with tool_call updates
7. **Ref pattern for callbacks**: IChatViewContainer and workspace event handlers use refs for latest values
8. **Context value stability**: ChatContext value created once (service instances), wrapped in useMemo
9. **Stable empty arrays**: Use module-level constants (e.g., `EMPTY_COMMANDS`) instead of inline `[]` in hook args

## Common Tasks

### Add New Feature Hook
1. Create `hooks/use[Feature].ts`
2. Define state with useState/useReducer
3. Export functions and state
4. Call the hook in `ui/ChatPanel.tsx`
5. Pass state/callbacks to child components as props
6. Wrap return object in `useMemo` if passed as dependency to other hooks

### Add Agent Type
1. Add settings type in `types/agent.ts`
2. Add config and defaults in `plugin.ts`
3. Add API key injection in `services/session-helpers.ts`
4. Update `ui/SettingsTab.ts` for configuration UI

### Modify Message Types
1. Update `ChatMessage`/`MessageContent` in `types/chat.ts`
2. If adding new session update type:
   - Add to `SessionUpdate` union in `types/session.ts`
   - Handle in `hooks/useAgentMessages.ts` (for message-level) or `hooks/useAgentSession.ts` (for session-level)
3. Update `acp/acp-handler.ts` `sessionUpdate()` to emit the new type
4. Update `ui/MessageBubble.tsx` `ContentBlock` to render new type

### Add New Session Update Type
1. Define interface in `types/session.ts`
2. Add to `SessionUpdate` union type
3. Handle in `hooks/useAgentSession.ts` `handleSessionUpdate()` (for session-level)
4. Or handle via `applySingleUpdate()` in `services/message-state.ts` (for message-level)
5. No routing needed in ChatPanel — useAgent handles dispatch internally

### Debug
1. Settings → Developer Settings → Debug Mode ON
2. Open DevTools (Cmd+Option+I / Ctrl+Shift+I)
3. Filter logs: `[AcpClient]`, `[AcpHandler]`, `[PermissionManager]`, `[VaultService]`

## ACP Protocol

**Communication**: JSON-RPC 2.0 over stdin/stdout

**Methods**: initialize, newSession, authenticate, prompt, cancel, setSessionConfigOption
**Notifications**: session/update (agent_message_chunk, agent_thought_chunk, user_message_chunk, tool_call, tool_call_update, plan, available_commands_update, current_mode_update, session_info_update, usage_update, config_option_update)
**Requests**: requestPermission
**Session Management** (unstable): session/list, session/load, session/resume, session/fork

**Agents**:
- Claude Code: `@agentclientprotocol/claude-agent-acp` (ANTHROPIC_API_KEY)
- Codex: `@agentclientprotocol/codex-acp` (OPENAI_API_KEY)
- Gemini CLI: `@google/gemini-cli` (GEMINI_API_KEY)
- Kiro CLI: `kiro-cli acp` (built-in ACP; Kiro account sign-in, no API key)
- OpenCode: `opencode acp` (built-in ACP; model backend configured in OpenCode, e.g. local ollama; no API key)
- Custom: Any ACP-compatible agent

## Keeping This File Current

This file is the source of truth for the codebase architecture and conventions. It should stay in sync with the code. Update it when:

- A new file is added to `src/` that introduces a concept (new hook, service, layer, UI component)
- An architectural rule changes (new constraint, new pattern, new layer boundary)
- A new agent type is supported
- A new ACP protocol method or session-update type is handled
- A common task is added or changes substantially

The release workflow prompts a review of this file before each version bump. If you're an AI assistant about to ship a release, scan the diff between the last tag and `main` and update the relevant sections here before bumping the version.

If you're touching `src/` and your change introduces or changes any of the above, also propose an update to this file in the same PR. Reviewers should reject PRs that add new architectural concepts without updating AGENTS.md.

---

**Last Updated**: July 2026 | **Architecture**: useAgent facade + sub-hooks + tab layer + context-note lifecycle + jsx-a11y keyboard-accessibility lint | **Version**: 2.0.0
