/**
 * Invariant probe definitions for the in-Obsidian invariant suite.
 *
 * Each invariant encodes a standing behavior that has regressed at least
 * once (the mapped Ixx class) and is probeable in a RUNNING Obsidian via
 * CDP `Runtime.evaluate` — the layer jsdom unit tests structurally cannot
 * reach (real workspace focus, keymap scope stack, plugin data on disk).
 *
 * Probes must be safe against a disposable smoke vault (studio / ST-*):
 * read-only where possible; any state they create (e.g. a new chat tab)
 * must be inconsequential in a vault with no precious sessions. The
 * runner refuses non-smoke vaults for this reason (see run.ts).
 *
 * Spec: vault note "Verification Overhaul" (Pillar 3).
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Cdp } from "../../screenshots/lib/cdp";

export type InvariantStatus = "pass" | "fail" | "skip" | "todo";

export interface InvariantResult {
	id: string;
	name: string;
	/** The regression class this guards (public PR refs live in the repo history). */
	guards: string;
	status: InvariantStatus;
	detail: string;
}

export interface Invariant {
	id: string;
	name: string;
	guards: string;
	run(cdp: Cdp): Promise<{ status: InvariantStatus; detail: string }>;
}

const PLUGIN_ID = "agent-console";
const VIEW_TYPE = "agent-console-chat-view";

/** Wrap a page-side IIFE so it returns a JSON string we can parse. */
function pageJson(body: string): string {
	return `JSON.stringify((() => { ${body} })())`;
}

async function evalJson<T>(cdp: Cdp, body: string): Promise<T> {
	const raw = await cdp.evaluate<string>(pageJson(body));
	return JSON.parse(raw) as T;
}

/**
 * INV-1 — Composer focus after "New chat".
 * Executes the new-chat command, then asserts document.activeElement is the
 * composer textarea. Guards the focus-return class (composer focus lost
 * after send / stop / new chat).
 */
const composerFocusNewChat: Invariant = {
	id: "INV-1",
	name: "Composer focus after new chat",
	guards: "focus-return class (I166)",
	async run(cdp) {
		await cdp.executeCommand(`${PLUGIN_ID}:open-chat-view`);
		await cdp.waitForElement(".agent-client-chat-input-textarea");
		await cdp.executeCommand(`${PLUGIN_ID}:new-chat`);
		// Focus lands after React commit; poll briefly instead of a blind sleep.
		const deadline = Date.now() + 3000;
		let detail = "";
		while (Date.now() < deadline) {
			const r = await evalJson<{ focused: boolean; active: string }>(
				cdp,
				`const ae = document.activeElement;
				 return {
					focused: !!ae && ae.classList.contains("agent-client-chat-input-textarea"),
					active: ae ? (ae.tagName + "." + (ae.className || "")) : "none",
				 };`,
			);
			if (r.focused) {
				return { status: "pass", detail: "activeElement is the composer textarea" };
			}
			detail = r.active;
			await delay(100);
		}
		return {
			status: "fail",
			detail: `composer not focused after new-chat; activeElement=${detail}`,
		};
	},
};

/**
 * INV-2 — No chat-UI keymap scope while the panel is inactive.
 * Switches the active leaf to a fresh empty leaf (a real focus-leave, the
 * user action behind the regression class), then asserts no scope on the
 * keymap stack is — or descends from — the chat view's scope. Obsidian
 * itself keeps the ACTIVE view's own (keyless) scope pushed; that is normal
 * and excluded. Restores the chat leaf afterwards. Guards the scope-leak
 * class (Cmd+W firing in editor leaves, accumulated scopes).
 */
const keymapScopeBalance: Invariant = {
	id: "INV-2",
	name: "No chat-UI keymap scope when panel inactive",
	guards: "scope-leak class (I156/I161/I155)",
	async run(cdp) {
		// A focus-shifting evaluate frequently drops its CDP response even
		// though the side effect lands (same pattern as Cdp.focusWindow).
		const evalTolerant = async (expr: string) => {
			try {
				await cdp.evaluate(expr);
			} catch {
				/* response dropped; side effect still lands */
			}
		};
		await evalTolerant(
			`(() => {
				const ws = window.app.workspace;
				const tmp = ws.getLeaf("tab");
				window.__invariantSuiteTempLeaf = tmp;
				ws.setActiveLeaf(tmp, { focus: true });
				return true;
			})()`,
		);
		await delay(400);
		try {
			const r = await evalJson<{
				switched: boolean;
				chatScopesOnStack: number;
				prevScopes: number;
			}>(
				cdp,
				`const ws = window.app.workspace;
				 const km = window.app.keymap;
				 const chatLeaf = ws.getLeavesOfType("${VIEW_TYPE}")[0];
				 const chatScope = chatLeaf ? chatLeaf.view.scope : null;
				 const active = ws.activeLeaf ? ws.activeLeaf.view.getViewType() : "none";
				 const stack = [km.scope, ...(km.prevScopes || [])];
				 const descendsFromChat = (s) => {
					let c = s, i = 0;
					while (c && i < 10) {
						if (chatScope && c === chatScope) return true;
						c = c.parent; i++;
					}
					return false;
				 };
				 return {
					switched: active !== "${VIEW_TYPE}",
					chatScopesOnStack: chatScope ? stack.filter(descendsFromChat).length : 0,
					prevScopes: (km.prevScopes || []).length,
				 };`,
			);
			if (!r.switched) {
				return {
					status: "skip",
					detail: "could not move active leaf off the chat view; probe inconclusive",
				};
			}
			if (r.chatScopesOnStack > 0) {
				return {
					status: "fail",
					detail: `${r.chatScopesOnStack} chat-UI scope(s) still on the keymap stack while the panel is inactive (prevScopes=${r.prevScopes})`,
				};
			}
			return {
				status: "pass",
				detail: "no chat-UI scope on the keymap stack with the panel inactive",
			};
		} finally {
			await evalTolerant(
				`(() => {
					const ws = window.app.workspace;
					const tmp = window.__invariantSuiteTempLeaf;
					if (tmp) { tmp.detach(); delete window.__invariantSuiteTempLeaf; }
					const chat = ws.getLeavesOfType("${VIEW_TYPE}")[0];
					if (chat) ws.setActiveLeaf(chat, { focus: true });
					return true;
				})()`,
			);
		}
	},
};

/**
 * INV-3 — Persisted-state integrity: saved-session index ⇔ disk artifacts,
 * and per-leaf tab slices reference known sessions. Guards the restore
 * class (blank restored history, session-store split).
 */
const persistedStateIntegrity: Invariant = {
	id: "INV-3",
	name: "Session index ⇔ disk artifacts ⇔ tab slices",
	guards: "restore class (TP-I01/TP-I06, I72)",
	async run(cdp) {
		const awaited = await cdp.evaluate<string>(
			`(async () => {
				const p = window.app.plugins.plugins["${PLUGIN_ID}"];
				const s = p.settings;
				const sessions = s.savedSessions || [];
				const dir = ".obsidian/plugins/${PLUGIN_ID}/sessions";
				let files = [];
				try {
					files = (await window.app.vault.adapter.list(dir)).files.map((f) => f.split("/").pop());
				} catch (e) {
					files = [];
				}
				const invalidEntries = sessions.filter((x) => !x.sessionId || !x.agentId).length;
				const missingFiles = sessions
					.filter((x) => !files.includes(x.sessionId + ".json"))
					.map((x) => x.sessionId);
				const known = new Set(sessions.map((x) => x.sessionId));
				const orphanSlices = [];
				for (const leaf of s.perLeafTabStates || []) {
					for (const t of leaf.tabs || []) {
						if (t.sessionId && !known.has(t.sessionId)) orphanSlices.push(t.sessionId);
					}
				}
				return JSON.stringify({ missingFiles, orphanSlices, invalidEntries, sessions: sessions.length });
			})()`,
			{ awaitPromise: true },
		);
		const parsed = JSON.parse(awaited) as {
			missingFiles: string[];
			orphanSlices: string[];
			invalidEntries: number;
			sessions: number;
		};
		const problems: string[] = [];
		if (parsed.invalidEntries > 0)
			problems.push(`${parsed.invalidEntries} index entries missing sessionId/agentId`);
		if (parsed.missingFiles.length > 0)
			problems.push(`index entries without disk file: ${parsed.missingFiles.join(", ")}`);
		if (parsed.orphanSlices.length > 0)
			problems.push(`tab slices referencing unknown sessions: ${parsed.orphanSlices.join(", ")}`);
		if (problems.length > 0) return { status: "fail", detail: problems.join("; ") };
		return {
			status: "pass",
			detail: `${parsed.sessions} index entries all have disk artifacts; all tab slices resolve`,
		};
	},
};

/**
 * INV-4 — Agent list completeness. getAvailableAgents() (the source every
 * picker renders from) must contain unique, non-empty ids and include every
 * enabled custom agent. Guards the wiring class (built-in/custom agents
 * absent from dropdown / picker).
 */
const agentListsComplete: Invariant = {
	id: "INV-4",
	name: "Agent pickers' data source is complete",
	guards: "wiring class (I167/I171)",
	async run(cdp) {
		const r = await evalJson<{
			ids: string[];
			customEnabled: string[];
			defaultAgentId: string | null;
		}>(
			cdp,
			`const p = window.app.plugins.plugins["${PLUGIN_ID}"];
			 const ids = p.getAvailableAgents().map((a) => a.id);
			 const customEnabled = (p.settings.customAgents || [])
				.filter((c) => c.enabled !== false)
				.map((c) => c.id);
			 return { ids, customEnabled, defaultAgentId: p.settings.defaultAgentId ?? null };`,
		);
		const problems: string[] = [];
		if (r.ids.length === 0) problems.push("getAvailableAgents() is empty");
		if (new Set(r.ids).size !== r.ids.length) problems.push("duplicate agent ids");
		if (r.ids.some((id) => !id)) problems.push("empty agent id present");
		const missingCustom = r.customEnabled.filter((id) => !r.ids.includes(id));
		if (missingCustom.length > 0)
			problems.push(`enabled custom agents missing: ${missingCustom.join(", ")}`);
		if (r.defaultAgentId && !r.ids.includes(r.defaultAgentId))
			problems.push(`defaultAgentId ${r.defaultAgentId} not in available agents`);
		if (problems.length > 0) return { status: "fail", detail: problems.join("; ") };
		return { status: "pass", detail: `${r.ids.length} agents, unique, custom+default resolved` };
	},
};

/**
 * INV-5 — Notification click reveal path. The onclick's foregrounding
 * mechanism is ChatView.revealOwningLeaf() (revealLeaf + setActiveLeaf);
 * every I52-class fix depends on it. Probes (1) the wiring — the chat view
 * exposes revealOwningLeaf (the missing-leaf-handle class), and (2) the
 * behavior — with another leaf active, revealOwningLeaf() reactivates the
 * chat leaf. The cross-window macOS activation race itself remains
 * human-verified (SF-6 / I52 T-recur repeated clicks).
 */
const notificationRouting: Invariant = {
	id: "INV-5",
	name: "Notification click reveal path (revealOwningLeaf)",
	guards: "notification class (I52 ×3, I168)",
	async run(cdp) {
		const evalTolerant = async (expr: string) => {
			try {
				await cdp.evaluate(expr);
			} catch {
				/* focus-shifting evaluate may drop its response; side effect lands */
			}
		};
		// Wiring check first (read-only).
		const wiring = await evalJson<{ hasLeaf: boolean; hasReveal: boolean }>(
			cdp,
			`const chat = window.app.workspace.getLeavesOfType("${VIEW_TYPE}")[0];
			 return {
				hasLeaf: !!chat,
				hasReveal: !!chat && typeof chat.view.revealOwningLeaf === "function",
			 };`,
		);
		if (!wiring.hasLeaf) {
			return { status: "skip", detail: "no chat view open; wiring unprobeable" };
		}
		if (!wiring.hasReveal) {
			return {
				status: "fail",
				detail: "ChatView does not expose revealOwningLeaf() — notification clicks have no sanctioned foregrounding path",
			};
		}
		// Behavior check: activate a temp leaf, reveal, expect the chat leaf back.
		await evalTolerant(
			`(() => {
				const ws = window.app.workspace;
				const tmp = ws.getLeaf("tab");
				window.__invariantSuiteInv5Leaf = tmp;
				ws.setActiveLeaf(tmp, { focus: true });
				return true;
			})()`,
		);
		await delay(300);
		try {
			await evalTolerant(
				`(() => {
					const chat = window.app.workspace.getLeavesOfType("${VIEW_TYPE}")[0];
					chat.view.revealOwningLeaf();
					return true;
				})()`,
			);
			// revealOwningLeaf resolves async (revealLeaf then setActiveLeaf);
			// poll for the reactivation instead of a single blind read.
			const deadline = Date.now() + 3000;
			let lastActive = "";
			while (Date.now() < deadline) {
				const r = await evalJson<{ active: string }>(
					cdp,
					`const ws = window.app.workspace;
					 return { active: ws.activeLeaf ? ws.activeLeaf.view.getViewType() : "none" };`,
				);
				if (r.active === VIEW_TYPE) {
					return {
						status: "pass",
						detail: "revealOwningLeaf() reactivated the chat leaf from a background state (cross-window OS race stays human-verified per SF-6)",
					};
				}
				lastActive = r.active;
				await delay(100);
			}
			return {
				status: "fail",
				detail: `revealOwningLeaf() did not reactivate the chat leaf (active view stayed ${lastActive})`,
			};
		} finally {
			await evalTolerant(
				`(() => {
					const tmp = window.__invariantSuiteInv5Leaf;
					if (tmp) { tmp.detach(); delete window.__invariantSuiteInv5Leaf; }
					return true;
				})()`,
			);
		}
	},
};

/**
 * INV-6 — Quick-prompt chips carry non-empty labels. Guards the cold-start
 * label race (chips rendered with blank/stale labels before metadataCache
 * resolved).
 */
const quickPromptLabels: Invariant = {
	id: "INV-6",
	name: "Quick-prompt chip labels non-empty",
	guards: "cold-start label race (QP-I27)",
	async run(cdp) {
		const r = await evalJson<{ total: number; empty: number; folderSet: boolean }>(
			cdp,
			`const p = window.app.plugins.plugins["${PLUGIN_ID}"];
			 const labels = Array.from(document.querySelectorAll(".agent-client-quick-prompt-chip-label"));
			 return {
				total: labels.length,
				empty: labels.filter((e) => !(e.textContent || "").trim()).length,
				folderSet: !!p.settings.quickPromptsFolder,
			 };`,
		);
		if (!r.folderSet) return { status: "skip", detail: "no quick-prompts folder configured in this vault" };
		if (r.total === 0)
			return { status: "fail", detail: "quick-prompts folder configured but zero chips rendered" };
		if (r.empty > 0)
			return { status: "fail", detail: `${r.empty}/${r.total} chips have empty labels` };
		return { status: "pass", detail: `${r.total} chips, all labeled` };
	},
};

/**
 * INV-7 — A2UI surface button labels stay inside the button box.
 * Measures a throwaway off-screen replica of a surface (Column and Row)
 * against the LIVE stylesheet, so it asserts real geometry — the layer
 * jsdom cannot reach at all (no layout engine). Read-only with respect to
 * app state: the replica is appended off-screen and removed in the same
 * evaluate, and no plugin/session state is touched. Guards the
 * label-overflow class: a label longer than the panel painting outside the
 * button, or an unbroken label growing the button past the surface card.
 */
const a2uiButtonLabelContainment: Invariant = {
	id: "INV-7",
	name: "A2UI button labels stay inside the button box",
	guards: "label-overflow class (A2UI-I06)",
	async run(cdp) {
		const r = await evalJson<{
			ruleFound: boolean;
			cases: {
				name: string;
				clientWidth: number;
				scrollWidth: number;
				hostWidth: number;
				buttonWidth: number;
				overflowsBox: boolean;
				escapesCard: boolean;
			}[];
		}>(
			cdp,
			`const LONG = "A: a deliberately long choice label that cannot fit on one line in a narrow panel";
			 const UNBROKEN = "Averyveryverylongsingletokenlabelwithnospacesatallthatcannotwrapnormally";
			 const probe = (name, containerClass, width, label) => {
				const host = document.createElement("div");
				host.style.cssText = "position:fixed;left:-9999px;top:0;width:" + width + "px";
				document.body.appendChild(host);
				try {
					const container = document.createElement("div");
					container.className = containerClass;
					host.appendChild(container);
					const b = document.createElement("button");
					b.className = "agent-client-a2ui-button";
					b.textContent = label;
					container.appendChild(b);
					const bw = b.getBoundingClientRect().width;
					const hw = host.getBoundingClientRect().width;
					return {
						name,
						clientWidth: b.clientWidth,
						scrollWidth: b.scrollWidth,
						hostWidth: host.clientWidth,
						buttonWidth: Math.round(bw),
						overflowsBox: b.scrollWidth > b.clientWidth + 1,
						escapesCard: bw > hw + 0.5,
					};
				} finally {
					host.remove();
				}
			 };
			 // Confirm our stylesheet is actually loaded, so a missing-CSS run
			 // cannot pass vacuously on the platform defaults alone.
			 let ruleFound = false;
			 for (const sheet of Array.from(document.styleSheets)) {
				try {
					for (const rule of Array.from(sheet.cssRules)) {
						if (rule.selectorText === ".agent-client-a2ui-button") { ruleFound = true; break; }
					}
				} catch (e) { /* cross-origin sheet; ignore */ }
				if (ruleFound) break;
			 }
			 return {
				ruleFound,
				cases: [
					probe("column/narrow", "agent-client-a2ui-column", 220, LONG),
					probe("column/typical", "agent-client-a2ui-column", 420, LONG),
					probe("row/unbroken-token", "agent-client-a2ui-row", 300, UNBROKEN),
				],
			 };`,
		);
		if (!r.ruleFound) {
			return {
				status: "fail",
				detail: "the .agent-client-a2ui-button rule is not in any loaded stylesheet — plugin CSS did not load (a full window reload is required after a CSS change)",
			};
		}
		const bad = r.cases.filter((c) => c.overflowsBox || c.escapesCard);
		if (bad.length > 0) {
			return {
				status: "fail",
				detail: bad
					.map(
						(c) =>
							`${c.name}: ${c.overflowsBox ? `label needs ${c.scrollWidth}px in a ${c.clientWidth}px box` : `button ${c.buttonWidth}px escapes a ${c.hostWidth}px card`}`,
					)
					.join("; "),
			};
		}
		return {
			status: "pass",
			detail: r.cases
				.map((c) => `${c.name} ${c.scrollWidth}/${c.clientWidth}px contained`)
				.join("; "),
		};
	},
};

/**
 * INV-8 — Idle loading indicator runs no animations.
 *
 * `.agent-client-loading-indicator` is hidden between turns with
 * `visibility: hidden`, which keeps its reserved layout box but does NOT
 * suspend CSS animations in Chromium (only `display: none` does). Before the
 * I198 fix the nine `dotPulse` dots therefore animated continuously for the
 * whole life of every open chat view, idle or not, pinning the compositor at
 * the display refresh rate (measured 120 fps sustained on ProMotion, surfaced
 * by macOS as "Using Significant Energy").
 *
 * jsdom cannot see this: it applies no stylesheets and runs no animations. So
 * the assertion has to happen against real rendered animations in a running
 * Obsidian. Also asserts a reduced-motion opt-out exists.
 *
 * Anti-vacuity: a VISIBLE replica must animate all nine dots. Without that
 * check, a zero for the hidden replica would also be produced by missing
 * keyframes or an unloaded stylesheet — passing for the wrong reason.
 */
const idleIndicatorNotAnimating: Invariant = {
	id: "INV-8",
	name: "Idle loading indicator runs no animations",
	guards: "hidden-indicator animation class (I198)",
	async run(cdp) {
		const r = await evalJson<{
			ruleFound: boolean;
			reducedMotionFound: boolean;
			hiddenRunning: number;
			visibleRunning: number;
			dots: number;
		}>(
			cdp,
			`const build = (hidden) => {
				const host = document.createElement("div");
				host.style.cssText = "position:fixed;left:-9999px;top:0;width:400px";
				document.body.appendChild(host);
				try {
					const ind = document.createElement("div");
					ind.className = "agent-client-loading-indicator" + (hidden ? " agent-client-hidden" : "");
					const wrap = document.createElement("div");
					wrap.className = "agent-client-loading-dots";
					for (let i = 0; i < 9; i++) {
						const d = document.createElement("div");
						d.className = "agent-client-loading-dot";
						wrap.appendChild(d);
					}
					ind.appendChild(wrap);
					host.appendChild(ind);
					const all = Array.from(wrap.querySelectorAll(".agent-client-loading-dot"));
					let running = 0;
					for (const d of all) {
						running += d.getAnimations().filter((a) => a.playState === "running").length;
					}
					return { running, count: all.length };
				} finally {
					host.remove();
				}
			 };
			 let ruleFound = false;
			 let reducedMotionFound = false;
			 for (const sheet of Array.from(document.styleSheets)) {
				try {
					for (const rule of Array.from(sheet.cssRules)) {
						if (rule.selectorText === ".agent-client-loading-dot") ruleFound = true;
						if (String(rule.cssText || "").indexOf("prefers-reduced-motion") >= 0) reducedMotionFound = true;
					}
				} catch (e) { /* cross-origin sheet; ignore */ }
			 }
			 const hidden = build(true);
			 const visible = build(false);
			 return {
				ruleFound,
				reducedMotionFound,
				hiddenRunning: hidden.running,
				visibleRunning: visible.running,
				dots: visible.count,
			 };`,
		);
		if (!r.ruleFound) {
			return {
				status: "fail",
				detail:
					"the .agent-client-loading-dot rule is not in any loaded stylesheet — plugin CSS did not load (a CSS change needs a FULL window reload, not plugin:reload)",
			};
		}
		if (r.visibleRunning !== r.dots) {
			return {
				status: "fail",
				detail: `visible indicator ran ${r.visibleRunning}/${r.dots} dot animations — probe cannot tell a fix from absent keyframes`,
			};
		}
		if (r.hiddenRunning !== 0) {
			return {
				status: "fail",
				detail: `hidden indicator still runs ${r.hiddenRunning} animation(s) — visibility:hidden does not suspend animations, so the dots animate for the life of the view`,
			};
		}
		if (!r.reducedMotionFound) {
			return {
				status: "fail",
				detail:
					"no @media (prefers-reduced-motion: reduce) block in any loaded stylesheet — the infinite animations have no opt-out",
			};
		}
		return {
			status: "pass",
			detail: `hidden 0 running; visible ${r.visibleRunning}/${r.dots} running; reduced-motion opt-out present`,
		};
	},
};

/** Chat view must exist before DOM probes run. */
export async function ensureChatViewOpen(cdp: Cdp): Promise<void> {
	const count = await cdp.evaluate<number>(
		`window.app.workspace.getLeavesOfType("${VIEW_TYPE}").length`,
	);
	if (count === 0) {
		await cdp.executeCommand(`${PLUGIN_ID}:open-chat-view`);
	}
	await cdp.waitForElement(".agent-client-chat-input-textarea", 10000);
}

export const invariants: Invariant[] = [
	composerFocusNewChat,
	keymapScopeBalance,
	persistedStateIntegrity,
	agentListsComplete,
	notificationRouting,
	quickPromptLabels,
	a2uiButtonLabelContainment,
	idleIndicatorNotAnimating,
];
