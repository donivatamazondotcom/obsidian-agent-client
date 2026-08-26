import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// tools/ is Node.js tooling (screenshot CDP scripts, CLI runners, benchmarks),
// not Obsidian renderer code. The obsidianmd ruleset targets plugin/renderer
// concerns (popout-window timers, no-console in shipped UI, sentence-case,
// component lifecycle) that don't apply to Node scripts — and several actively
// misfire there (e.g. `window` is undefined in Node, console output is the
// whole point of a CLI). Turn every obsidianmd rule off for tools/; the
// typescript-eslint rules stay on so real type/correctness issues are caught.
const obsidianmdRulesOff = Object.fromEntries(
	Object.keys(obsidianmd.rules).map((rule) => [`obsidianmd/${rule}`, "off"]),
);

// Shared no-restricted-syntax selectors (I115 menu routing + I134 platform
// glyph / process.platform guards). Extracted so the persistence-stack
// exemption below can reuse them WITHOUT the saveSession ban — keeping every
// other guard active there. If you add a global selector, add it here so
// services/** keeps it too.
const baseRestrictedSyntax = [
	{
		selector: "CallExpression[callee.property.name='showAtMouseEvent']",
		message:
			"Route menus through showMenuAtEvent() (utils/menu-registry) instead of calling menu.showAtMouseEvent directly, so keyboard activation anchors to the trigger element (I115).",
	},
	{
		selector: "CallExpression[callee.property.name='showAtPosition']",
		message:
			"Route menus through showMenuAtEvent() (utils/menu-registry) instead of calling menu.showAtPosition directly (I115).",
	},
	{
		selector: "Literal[value=/[⌘⌥⇧⌃]/]",
		message:
			"Don't hardcode Mac modifier glyphs (⌘ ⌥ ⇧ ⌃) — route through MOD_KEY/ALT_KEY/SHIFT_KEY/modCombo in utils/platform.ts so Windows/Linux show Ctrl/Alt/Shift (I134).",
	},
	{
		selector: "TemplateElement[value.raw=/[⌘⌥⇧⌃]/]",
		message:
			"Don't hardcode Mac modifier glyphs (⌘ ⌥ ⇧ ⌃) in template strings — route through utils/platform.ts (I134).",
	},
	{
		// Platform branching is owned by utils/platform.ts (MOD_KEY /
		// prepareShellCommand / WSL + Windows-PATH helpers). Reading
		// process.platform elsewhere re-introduces the variance the platform util
		// normalizes once at the edge. platform.ts is exempt below. (Sibling of I134.)
		selector:
			"MemberExpression[object.name='process'][property.name='platform']",
		message:
			"Don't read process.platform directly — branch via utils/platform.ts so the platform check lives in one place (I134 sibling).",
	},
	{
		// Three mechanisms rendered tooltips in this UI and nothing ranked them,
		// so duplicates kept recurring: setTooltip() from obsidian, a hand-written
		// aria-label, and the DOM `title` attribute. The first two are the SAME
		// mechanism — setTooltip's implementation IS aria-label (verified against
		// the running app 2026-08-25) — which is why nobody noticed the third one
		// is different. `title` renders the OS-native tooltip (square, no arrow,
		// different font), so an element carrying `title` AND either of the others
		// shows TWO tooltips, styled differently, sometimes saying different
		// things. It "works", which is what made it invisible.
		//
		// Because setTooltip writes aria-label, tooltip text is also the
		// accessible name — so tooltip text that omits the element's visible label
		// is a WCAG 2.5.3 label-in-name regression. attachTooltip()
		// (ui/shared/useTooltip) owns that composition in one place.
		//
		// Scope is the JSX ATTRIBUTE only. SVG `<title>` ELEMENTS, object
		// properties named `title` (session records), TS interface/type members,
		// `rec.title` reads and "<title>…</title>" marker strings are all
		// untouched — pinned as negative fixtures in
		// src/__tests__/title-attribute-ban.test.ts, which also drives the
		// selector against positives so a rule that matches nothing cannot pass
		// silently. ToolbarDropdown's `title=` call sites are JSX attributes on a
		// React component and DO trip this, which is intended: the prop is named
		// `tooltip` now (I199 part 3).
		selector: "JSXAttribute[name.name='title']",
		message:
			"Don't use the `title` attribute — it renders a second, OS-native tooltip alongside Obsidian's, and Obsidian's tooltip comes from aria-label. Use attachTooltip() from ui/shared/useTooltip, which routes through setTooltip and keeps the visible label in the accessible name (I199).",
	},
];

// Phase 4 §2c (the former "1b"): every savedSessions metadata/title write must
// go through the single serialized writer (SessionStore via
// settingsService.sessionStore). A direct .saveSession() in ui/ or hooks/ races
// the turn-end / AI-title writers and clobbers titles (the I114/I121 class).
// The persistence stack (src/services/**) is exempt below — it IS the writer.
// G4 (design-integrity audit): `savedSessions` lives inside the settings blob,
// so `plugin.saveData(this.settings)` is a SECOND door onto the same persisted
// store that the SessionStore single-writer guards. The saveSessionBan below
// proves "one call-site name"; this proves the other door stays shut. The whole
// -settings flush in plugin.ts is the one sanctioned caller (exempted below), so
// any NEW saveData call has to be argued for rather than typed.
const saveDataBan = {
	selector: "CallExpression[callee.property.name='saveData']",
	message:
		"Don't call .saveData() outside src/plugin.ts — it writes the whole settings blob, which contains savedSessions, and races the serialized SessionStore writers (the I114/I121 class). Route session metadata through settingsService.sessionStore; route new settings fields through SettingsService.",
};

const saveSessionBan = {
	selector: "CallExpression[callee.property.name='saveSession']",
	message:
		"Don't call .saveSession() directly — it races the serialized writers and clobbers titles (I114/I121). Route metadata/title writes through SessionStore (settingsService.sessionStore): recordTurnSave / applySuggestedTitle / renameSession / recordFirstMessage. (Phase 4 §2c — see 'Lint Enforcement for Design Patterns'.)",
};

export default defineConfig([
	{
		ignores: ["node_modules/", "main.js", "docs/", "vitest.config.ts", ".trees/", "tools/benchmark/token-efficiency.ts", "**/__tests__/**", "**/*.test.ts", "**/*.test.tsx", "**/*.bench.ts"],
	},
	...obsidianmd.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
		},
		rules: {
			// Preserve existing rules
			// Menu positioning must go through showMenuAtEvent() (utils/menu-registry)
			// so keyboard activation anchors to the trigger element instead of the
			// viewport origin (I115). Forbid the raw Obsidian APIs everywhere except
			// the wrapper itself (exempted below).
			"no-restricted-syntax": [
				"error",
				...baseRestrictedSyntax,
				saveSessionBan,
				saveDataBan,
			],
			// The ACP SDK (@agentclientprotocol/sdk) is the system's external
			// contract and must stay behind the anti-corruption boundary in
			// src/acp/ (AcpClient port + AcpHandler/type-converter adapters). Any
			// other module must speak domain types, never the raw SDK shape, so a
			// change to the SDK can't ripple across the app. src/acp/** is exempt
			// below. (Anti-corruption boundary tenet — see "Lint Enforcement for
			// Design Patterns".)
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "@agentclientprotocol/sdk",
							message:
								"ACP SDK types must not escape src/acp/. Speak domain types; route through AcpClient / AcpHandler / type-converter (anti-corruption boundary).",
						},
					],
				},
			],
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-empty-function": "off",
			// Tagged-union exhaustiveness: a switch over a union that omits a
			// case (and has no default) fails the build, so a decision point
			// can't silently miss a new union member. considerDefaultExhaustive:
			// true lets event routers opt out with a `default`; decision points
			// (resolvers/reducers) stay strict by omitting one. See "Lint
			// Enforcement for Design Patterns" (Phase 3).
			"@typescript-eslint/switch-exhaustiveness-check": [
				"error",
				{ considerDefaultExhaustiveForUnions: true },
			],
			// 58 pre-existing violations across SettingsTab, ChatPanel, ChatView,
			// InputArea — many are legitimate proper nouns (e.g. "Windows Subsystem
			// for Linux", "Gemini API key") or technical UI strings. Demote to
			// warn until a dedicated cleanup pass.
			"obsidianmd/ui/sentence-case": "warn",
		},
	},
	{
		// Keyboard accessibility — enforce on React components (.tsx only).
		files: ["**/*.tsx"],
		plugins: { "jsx-a11y": jsxA11y },
		rules: {
			"jsx-a11y/click-events-have-key-events": "error",
			"jsx-a11y/no-static-element-interactions": "error",
			"jsx-a11y/no-noninteractive-element-interactions": "error",
			"jsx-a11y/interactive-supports-focus": "error",
		},
	},
	{
		// Node tooling — disable the obsidian renderer ruleset (see note above).
		files: ["tools/**/*.ts"],
		rules: obsidianmdRulesOff,
	},
	{
		// showMenuAtEvent is the sanctioned menu-positioning wrapper; it must call
		// the raw Menu APIs that every other module is forbidden from touching.
		files: ["src/utils/menu-registry.ts"],
		rules: { "no-restricted-syntax": "off" },
	},
	{
		// platform.ts is the single source of truth for the modifier-label glyphs
		// (I134) — it legitimately contains ⌘/⌥/⇧. It is a shell/platform util that
		// never calls Menu APIs, so dropping no-restricted-syntax wholesale here is
		// safe (the I115 menu rule has nothing to catch in this file).
		files: ["src/utils/platform.ts"],
		rules: { "no-restricted-syntax": "off" },
	},
	{
		// src/acp/ is the anti-corruption boundary — the only place allowed to
		// import the raw ACP SDK (AcpClient port + AcpHandler/type-converter
		// adapters). Exempt it from the SDK import ban.
		files: ["src/acp/**"],
		rules: { "no-restricted-imports": "off" },
	},
	{
		// src/resolvers/ is the functional core — pure decision functions
		// (derive*/decide*) that take plain inputs and return tagged unions.
		// They must not import the imperative shell (React, Obsidian) or the raw
		// ACP SDK, so the core stays framework-free and exhaustively unit-testable
		// (functional-core / imperative-shell). Totality is covered by the
		// exhaustiveness rule + tests, not a throw ban. See "Lint Enforcement for
		// Design Patterns".
		files: ["src/resolvers/**"],
		rules: {
			// Decision points stay STRICTLY exhaustive. Globally the
			// exhaustiveness rule runs with considerDefaultExhaustiveForUnions:
			// true so event routers can opt out with a neutral `default` — but
			// that same keyword is the silencing move: adding `default` to a
			// resolver switch clears a genuine missing-case error and swallows
			// the new union member. Two guards, both zero-violation today (the
			// 4 switches in this zone carry no default):
			//   1. the rule runs strict here, so a default does NOT count as
			//      exhaustive;
			//   2. a `default` clause in this zone is a lint error outright, so
			//      the escape hatch has to be argued for rather than typed.
			"@typescript-eslint/switch-exhaustiveness-check": [
				"error",
				{ considerDefaultExhaustiveForUnions: false },
			],
			// Spread the base selectors + saveSession ban: a bare
			// no-restricted-syntax here would SHADOW the shared config and
			// silently drop the I115 menu, I134 glyph/process.platform and
			// single-writer guards for this zone (same hazard the services/**
			// override documents).
			"no-restricted-syntax": [
				"error",
				...baseRestrictedSyntax,
				saveSessionBan,
				saveDataBan,
				{
					selector: "SwitchCase[test=null]",
					message:
						"No `default` clause in src/resolvers/ — resolvers are total decision functions and must handle every union member explicitly, so a new member fails the build instead of falling through. Use assertNever for the impossible branch, or move the switch out of the resolver zone if it is a router rather than a decision point.",
				},
			],
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "react",
							message:
								"Resolvers are pure — no React. Keep the functional core framework-free; let the imperative shell (ui/, hooks/) render.",
						},
						{
							name: "react-dom",
							message:
								"Resolvers are pure — no React. Keep the functional core framework-free.",
						},
						{
							name: "obsidian",
							message:
								"Resolvers are pure — no Obsidian. Take plain inputs (and types from src/types); let the imperative shell touch the platform.",
						},
						{
							name: "@agentclientprotocol/sdk",
							message:
								"ACP SDK types must not escape src/acp/. Resolvers speak domain types.",
						},
					],
				},
			],
		},
	},
	{
		// The persistence stack IS the single writer of record — it must call
		// .saveSession() (SessionStore.port + SettingsService delegate +
		// SessionStorage). Reuse the base selectors so the I115/I134 guards stay
		// active here, but WITHOUT the saveSession ban. (Phase 4 §2c.)
		files: ["src/services/**"],
		rules: {
			// Exempt from the saveSession ban (this layer IS the writer) but NOT
			// from the saveData ban — the whole-settings flush belongs to plugin.ts.
			"no-restricted-syntax": ["error", ...baseRestrictedSyntax, saveDataBan],
		},
	},
	{
		// plugin.ts owns the whole-settings flush (`this.saveData(this.settings)`
		// in saveSettings), so it is the one sanctioned saveData caller. Re-list
		// the other selectors rather than switching the rule off, so this file
		// keeps the I115 menu, I134 glyph/process.platform and single-writer
		// guards. (G4 — design-integrity audit.)
		files: ["src/plugin.ts"],
		rules: {
			"no-restricted-syntax": ["error", ...baseRestrictedSyntax, saveSessionBan],
		},
	},
]);
