import * as React from "react";
const { useRef, useEffect, useCallback, useMemo } = React;
import { setIcon, Menu } from "obsidian";

import { registerOpenMenu, showMenuAtEvent } from "../utils/menu-registry";
import { useTooltip } from "./shared/useTooltip";
import { isSessionLive } from "../resolvers/send-affordance";
import type { TabSessionState } from "../hooks/useTabSessionState";
import { t } from "../i18n";
import {
	flattenConfigSelectOptions,
	type SessionModeState,
	type SessionModelState,
	type SessionUsage,
	type SessionConfigOption,
	type SessionConfigSelectGroup,
} from "../types/session";

// ============================================================================
// ToolbarDropdown — themed dropdown using Obsidian's Menu
// ============================================================================

interface ToolbarDropdownItem {
	value: string;
	label: string;
	groupName?: string;
}

interface ToolbarDropdownProps {
	label: string;
	/**
	 * The extra thing the tooltip explains (what this dropdown selects, or the
	 * current option's description) — NOT the accessible name on its own. It is
	 * composed with `label` so the visible text survives into the accessible
	 * name (WCAG 2.5.3); see ui/shared/useTooltip. Named `tooltip` to match
	 * HeaderButton: the old name `title` taught "title is how you do tooltips
	 * here", one step from writing the DOM `title` attribute that renders a
	 * second, OS-native tooltip (I199).
	 */
	tooltip: string;
	items: ToolbarDropdownItem[];
	currentValue: string | undefined;
	onChange: (value: string) => void;
	className?: string;
}

/**
 * Themed dropdown trigger. Uses Obsidian's Menu instead of a native <select>
 * so the open state respects Obsidian theme tokens, supports keyboard nav,
 * and can be positioned above the trigger to avoid covering the input.
 */
function ToolbarDropdown({
	label,
	tooltip,
	items,
	currentValue,
	onChange,
	className,
}: ToolbarDropdownProps) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	const chevronRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (chevronRef.current) {
			setIcon(chevronRef.current, "chevron-down");
		}
	}, []);

	const handleClick = useCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			e.preventDefault();
			e.stopPropagation();

			// Keyboard activation (Enter/Space) reports detail === 0. Keep the
			// trigger focused in that case so the focus ring stays and the menu
			// can be reopened; on a plain dismiss (Esc / outside click) return
			// focus to it when the menu closes, since Obsidian's Menu does not
			// restore trigger focus. On an actual PICK, leave focus alone so the
			// caller's onChange can return it to the composer (D5 composer-focus
			// return). Mouse activation blurs as before (no ring expected). (I123)
			const triggeredByKeyboard = e.detail === 0;
			let itemSelected = false;
			const menu = new Menu();

			registerOpenMenu(
				menu,
				triggeredByKeyboard
					? () => {
							if (!itemSelected) buttonRef.current?.focus();
						}
					: undefined,
			);

			menu.addItem((menuItem) => {
				menuItem.setTitle(tooltip).setIsLabel(true);
			});

			let lastGroupName: string | undefined;
			for (const item of items) {
				if (
					item.groupName &&
					item.groupName !== lastGroupName &&
					lastGroupName !== undefined
				) {
					menu.addSeparator();
				}
				lastGroupName = item.groupName;

				menu.addItem((menuItem) => {
					menuItem
						.setTitle(item.label)
						.setChecked(item.value === currentValue)
						.onClick(() => {
							itemSelected = true;
							onChange(item.value);
						});
				});
			}

			showMenuAtEvent(menu, e);
			// Mouse activation: drop focus so no control lingers focused after a
			// pointer click. Keyboard activation keeps focus (restored on hide
			// via the registerOpenMenu callback above). (I123)
			if (!triggeredByKeyboard) buttonRef.current?.blur();
		},
		[items, currentValue, onChange, tooltip],
	);

	const wrapperClass = `clickable-icon agent-client-toolbar-dropdown${className ? ` ${className}` : ""}`;

	// The button shows `label` (e.g. "Sonnet 4.5") while `tooltip` carries the
	// description. Setting aria-label to the description alone — which is what
	// this component did until I199 — replaced the accessible name with text the
	// user cannot see, so speech input could not activate it. attachTooltip
	// composes both.
	useTooltip(buttonRef, { visibleLabel: label, reason: tooltip });

	return (
		<button
			ref={buttonRef}
			type="button"
			// keep in sync with FOCUS_CLUSTER_ATTR (composer-focus-tracker)
			data-acp-focus-cluster=""
			className={wrapperClass}
			onClick={handleClick}
		>
			<span className="agent-client-toolbar-dropdown-label-area">
				{items.map((item) => (
					<span
						key={item.value}
						className="agent-client-toolbar-dropdown-sizer"
					>
						{item.label}
					</span>
				))}
				<span className="agent-client-toolbar-dropdown-label">
					{label}
				</span>
			</span>
			<span
				ref={chevronRef}
				className="agent-client-toolbar-dropdown-chevron"
				aria-hidden="true"
			/>
		</button>
	);
}

// ============================================================================
// Utility Functions
// ============================================================================

/** Format token count for display (e.g., 21367 → "21.4K", 200000 → "200K") */
function formatTokenCount(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	const k = tokens / 1000;
	return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
}

/** Get CSS class for usage percentage color thresholds */
function getUsageColorClass(percentage: number): string {
	if (percentage >= 90) return "agent-client-usage-danger";
	if (percentage >= 80) return "agent-client-usage-warning";
	if (percentage >= 70) return "agent-client-usage-caution";
	return "agent-client-usage-normal";
}

// ============================================================================
// InputToolbar
// ============================================================================

export interface InputToolbarProps {
	isSending: boolean;
	isButtonDisabled: boolean;
	hasContent: boolean;
	onSendOrStop: () => void;
	modes?: SessionModeState;
	onModeChange?: (modeId: string) => void;
	models?: SessionModelState;
	onModelChange?: (modelId: string) => void;
	configOptions?: SessionConfigOption[];
	onConfigOptionChange?: (configId: string, value: string) => void;
	usage?: SessionUsage;
	lazyState: TabSessionState;
}

export function InputToolbar({
	isSending,
	isButtonDisabled,
	hasContent,
	onSendOrStop,
	modes,
	onModeChange,
	models,
	onModelChange,
	configOptions,
	onConfigOptionChange,
	usage,
	lazyState,
}: InputToolbarProps) {
	const sendButtonRef = useRef<HTMLButtonElement>(null);

	const updateIconColor = useCallback(
		(svg: SVGElement) => {
			svg.classList.remove(
				"agent-client-icon-sending",
				"agent-client-icon-active",
				"agent-client-icon-inactive",
			);

			if (isSending) {
				svg.classList.add("agent-client-icon-sending");
			} else {
				svg.classList.add(
					hasContent
						? "agent-client-icon-active"
						: "agent-client-icon-inactive",
				);
			}
		},
		[isSending, hasContent],
	);

	useEffect(() => {
		if (sendButtonRef.current) {
			const iconName = isSending ? "square" : "send-horizontal";
			setIcon(sendButtonRef.current, iconName);
			const svg = sendButtonRef.current.querySelector("svg");
			if (svg) {
				updateIconColor(svg);
			}
		}
	}, [isSending, updateIconColor]);

	useEffect(() => {
		if (sendButtonRef.current) {
			const svg = sendButtonRef.current.querySelector("svg");
			if (svg) {
				updateIconColor(svg);
			}
		}
	}, [updateIconColor]);

	// ----- Build dropdown item lists (memoized) -----

	const modeItems = useMemo<ToolbarDropdownItem[]>(() => {
		if (!modes?.availableModes) return [];
		return modes.availableModes.map((m) => ({
			value: m.id,
			label: m.name,
		}));
	}, [modes]);

	const modelItems = useMemo<ToolbarDropdownItem[]>(() => {
		if (!models?.availableModels) return [];
		return models.availableModels.map((m) => ({
			value: m.modelId,
			label: m.name,
		}));
	}, [models]);

	const currentModeLabel = useMemo(() => {
		const id = modes?.currentModeId;
		return (
			modes?.availableModes?.find((m) => m.id === id)?.name ??
			t("chat.composer.mode")
		);
	}, [modes]);

	const currentModelLabel = useMemo(() => {
		const id = models?.currentModelId;
		return (
			models?.availableModels?.find((m) => m.modelId === id)?.name ??
			t("chat.composer.model")
		);
	}, [models]);

	// ----- Render -----

	return (
		<div className="agent-client-chat-input-actions">
			{/* Context Usage Indicator — sits in the left cluster, right of the
			    zap launcher (left/right split is owned by the spacer below, not
			    this element, so the launcher stays text-left-anchored even for
			    agents that don't report usage). */}
			{usage && (
				<span
					className={`agent-client-usage-indicator ${getUsageColorClass(Math.round((usage.used / usage.size) * 100))}`}
					aria-label={
						usage.cost
							? `${t("chat.composer.usageTokens", { used: formatTokenCount(usage.used), size: formatTokenCount(usage.size) })}\n$${usage.cost.amount.toFixed(2)}`
							: t("chat.composer.usageTokens", {
									used: formatTokenCount(usage.used),
									size: formatTokenCount(usage.size),
								})
					}
				>
					{Math.round((usage.used / usage.size) * 100)}%
				</span>
			)}

			{/* Flex spacer — always present, owns the left/right split so the
			    zap launcher (+ optional usage %) stay text-left while the
			    dropdowns + send button stay right, regardless of which
			    conditional elements render. */}
			<span className="agent-client-toolbar-spacer" aria-hidden="true" />

			{/* Config Options (supersedes legacy mode/model selectors) */}
			{configOptions && configOptions.length > 0
				? configOptions.map((option) => {
						const flatOptions = flattenConfigSelectOptions(
							option.options,
						);
						if (flatOptions.length <= 1) return null;

						const isGrouped =
							option.options.length > 0 &&
							"group" in option.options[0];

						let items: ToolbarDropdownItem[];
						if (isGrouped) {
							items = [];
							for (const group of option.options as SessionConfigSelectGroup[]) {
								for (const opt of group.options) {
									items.push({
										value: opt.value,
										label: `${group.name} / ${opt.name}`,
										groupName: group.name,
									});
								}
							}
						} else {
							items = flatOptions.map((opt) => ({
								value: opt.value,
								label: opt.name,
							}));
						}

						const currentItem = items.find(
							(it) => it.value === option.currentValue,
						);
						const label = currentItem?.label ?? option.name;
						const tooltip = option.description ?? option.name;

						return (
							<ToolbarDropdown
								key={option.id}
								label={label}
								tooltip={tooltip}
								items={items}
								currentValue={option.currentValue}
								onChange={(value) => {
									onConfigOptionChange?.(option.id, value);
								}}
								className={
									option.category
										? `agent-client-config-selector-${option.category}`
										: undefined
								}
							/>
						);
					})
				: (
					<>
						{modes && modes.availableModes.length > 1 && onModeChange && (
							<ToolbarDropdown
								label={currentModeLabel}
								tooltip={
									modes.availableModes.find(
										(m) => m.id === modes.currentModeId,
									)?.description ?? t("chat.composer.selectMode")
								}
								items={modeItems}
								currentValue={modes.currentModeId ?? undefined}
								onChange={onModeChange}
							/>
						)}

						{models &&
							models.availableModels.length > 1 &&
							onModelChange && (
								<ToolbarDropdown
									label={currentModelLabel}
									tooltip={
										models.availableModels.find(
											(m) =>
												m.modelId ===
												models.currentModelId,
										)?.description ?? t("chat.composer.selectModel")
									}
									items={modelItems}
									currentValue={
										models.currentModelId ?? undefined
									}
									onChange={onModelChange}
								/>
							)}
					</>
				)}

			{/* Send/Stop Button */}
			<button
				ref={sendButtonRef}
				onClick={onSendOrStop}
				disabled={isButtonDisabled}
				className={`clickable-icon agent-client-chat-send-button ${isSending ? "sending" : ""} ${isButtonDisabled ? "agent-client-disabled" : ""}`}
				aria-label={
					isSending
						? t("chat.composer.stopGeneration")
						: lazyState === "idle"
							? t("chat.composer.sendToConnect")
							: !isSessionLive(lazyState)
								? t("chat.composer.connecting")
								: t("chat.composer.sendMessage")
				}
			></button>
		</div>
	);
}
