/**
 * `title`-attribute ban guard (I199) — proves the SHIPPED ESLint selector
 * catches the JSX `title` attribute and nothing else.
 *
 * Why this exists: the ban is a `no-restricted-syntax` selector, and a selector
 * that matches NOTHING passes silently. `npx eslint src/` exits 0 whether the
 * rule is working or misspelled, so "lint is green" is not evidence the guard
 * is live — it is exactly the proxy-for-success trap. This test drives the
 * selector against fixtures so a typo, an AST-shape change in a parser bump, or
 * a zone override that shadows the rule fails loudly here.
 *
 * Two properties matter, and BOTH need asserting:
 *
 *  1. **It fires.** A DOM `title=`, a component `title=` prop, and a `title=`
 *     on a `<label>` are all violations. This is the half a "0 errors" run
 *     cannot distinguish from a dead rule.
 *  2. **It is narrow.** The codebase legitimately contains ~70 object
 *     properties named `title` (session records), TS interface/type members
 *     named `title`, `rec.title` member reads, and `"<title>…</title>"` marker
 *     strings in `utils/titleMarker.ts` + `utils/system-instructions.ts`. A
 *     selector that swept those up would be unusable, so each shape is pinned
 *     as a negative. SVG `<title>` elements are pinned too: none exist in `src/`
 *     today, so nothing else would notice if the selector started matching them.
 *
 * The selector is read from the shipped `eslint.config.mjs` rather than copied
 * here, so the test and the rule cannot drift. It is loaded via a computed
 * dynamic import: a static `import "../../eslint.config.mjs"` would be
 * typechecked by `tsc -noEmit` (tests are inside tsconfig's `include`) and the
 * plugin graph it pulls in has no usable declarations. A computed specifier is
 * opaque to tsc and resolved by Vite at runtime, so the real artifact is under
 * test without coupling the production build to it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Linter } from "eslint";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Both of these are loaded through a COMPUTED specifier so `tsc` never resolves
 * them. tsconfig uses `moduleResolution: "node"` (node10), which cannot see
 * typescript-eslint's `exports`-map types, and `target: ES6`, which forbids
 * top-level await — while the production build typechecks this file because
 * tests are inside tsconfig's `include`. A runtime-only import keeps the guard
 * honest (it tests the real shipped artifact) without dragging either
 * constraint into the build.
 */
const PARSER_MODULE = "@typescript-eslint/parser";

/** The global zone in `eslint.config.mjs` that owns `baseRestrictedSyntax`. */
const BASE_ZONE_FILES = ["**/*.ts", "**/*.tsx"];

/** Marker the ban's message must carry, so the entry is findable by intent. */
const ISSUE_MARKER = "I199";

interface RestrictedEntry {
	selector: string;
	message: string;
}

interface ConfigZone {
	files?: string[];
	rules?: Record<string, unknown>;
}

async function loadShippedConfig(): Promise<ConfigZone[]> {
	// process.cwd() is the package root under vitest.
	const href = pathToFileURL(resolve(process.cwd(), "eslint.config.mjs")).href;
	const mod = (await import(/* @vite-ignore */ href)) as {
		default: ConfigZone[];
	};
	return mod.default;
}

/** Every zone that configures `no-restricted-syntax`, with its entry list. */
function restrictedSyntaxZones(
	config: ConfigZone[],
): { files: string[]; entries: RestrictedEntry[] }[] {
	const out: { files: string[]; entries: RestrictedEntry[] }[] = [];
	for (const zone of config) {
		const rule = zone.rules?.["no-restricted-syntax"];
		// Shape is ["error", ...entries]; a bare "off" string carries no entries.
		if (!Array.isArray(rule)) continue;
		out.push({
			files: zone.files ?? [],
			entries: rule.slice(1) as RestrictedEntry[],
		});
	}
	return out;
}

function titleBanEntries(entries: RestrictedEntry[]): RestrictedEntry[] {
	return entries.filter((e) => e.message?.includes(ISSUE_MARKER));
}

let zones: { files: string[]; entries: RestrictedEntry[] }[] = [];
let baseZone: { files: string[]; entries: RestrictedEntry[] } | undefined;
let shippedBan: RestrictedEntry | undefined;
let parser: Linter.Parser;

beforeAll(async () => {
	const mod = (await import(/* @vite-ignore */ PARSER_MODULE)) as {
		default?: unknown;
		parseForESLint?: unknown;
	};
	// The package ships both a default export and named members depending on
	// the interop path; take whichever carries parseForESLint.
	parser = (mod.parseForESLint ? mod : mod.default) as Linter.Parser;

	const config = await loadShippedConfig();
	zones = restrictedSyntaxZones(config);
	baseZone = zones.find(
		(z) => JSON.stringify(z.files) === JSON.stringify(BASE_ZONE_FILES),
	);
	shippedBan = baseZone ? titleBanEntries(baseZone.entries)[0] : undefined;
});

// ---------------------------------------------------------------------------
// Fixtures. `POS` must be flagged; `NEG` must not.
// ---------------------------------------------------------------------------

const POSITIVE: Record<string, string> = {
	"DOM title attribute": `const a = <button title="x" />;`,
	"component title prop": `const a = <Drop title={tip} label={l} />;`,
	"title on a label element": `const a = <label title={s}><input /></label>;`,
	"title on an element inside svg": `const a = <svg><rect title="r" /></svg>;`,
};

const NEGATIVE: Record<string, string> = {
	"SVG <title> element": `const a = <svg><title>Chart</title></svg>;`,
	"SVG <title> with expression": `const a = <svg><title>{name}</title></svg>;`,
	"object property named title": `const r = { id: 1, title: "Session A" };`,
	"member read of .title": `const s = rec.title; f(rec.title);`,
	"shorthand property title": `const title = "x"; const r = { title };`,
	"interface member named title": `interface S { title: string }\nconst x: S = { title: "a" };`,
	"type alias member named title": `type S = { title?: string };`,
	"string containing a title marker": `const s = "emit <title>here</title> first";`,
	"template containing a title marker": "const s = `<title>${v}</title>`;",
	"title-adjacent JSX attributes": `const a = <b titleCase={x} data-title={y} aria-label={z} />;`,
	"setTooltip and Menu setTitle calls": `setTooltip(el, "x");\nitem.setTitle("y");`,
};

/** Lint `code` with a single selector, returning violation count. */
function violationsFor(selector: string, code: string): number {
	const linter = new Linter();
	const messages = linter.verify(
		code,
		{
			files: ["**/*.tsx"],
			languageOptions: {
				ecmaVersion: 2022,
				sourceType: "module",
				// The repo lints .ts/.tsx with typescript-eslint, so the guard
				// must run on the same AST the rule sees in CI. espree cannot
				// parse the TS-only fixtures (interface / type alias) at all.
				parser,
				parserOptions: { ecmaFeatures: { jsx: true } },
			},
			rules: {
				"no-restricted-syntax": ["error", { selector, message: "HIT" }],
			},
		} as Linter.Config,
		// Filename must match the `files` glob above or the flat config
		// matches nothing and every fixture reports zero — the exact silent
		// pass the CONTROL test below exists to catch.
		"fixture.tsx",
	);
	const fatal = messages.find((m) => m.fatal);
	if (fatal) {
		throw new Error(`fixture failed to parse: ${fatal.message}\n${code}`);
	}
	return messages.filter((m) => m.message === "HIT").length;
}

describe("title-attribute ban (I199)", () => {
	it("CONTROL: the lint harness reports violations at all", () => {
		// Without this, every "expected 0 violations" assertion below would
		// pass trivially against a harness that lints nothing. Uses a selector
		// unrelated to the ban so it stays valid if the ban's shape changes.
		expect(
			violationsFor("VariableDeclaration", `const a = <button title="x" />;`),
			"the fixture linter produced no violations for a selector that must match — the harness is inert, so no other assertion in this file means anything",
		).toBe(1);
	});

	it("the shipped config declares exactly one title-attribute ban", () => {
		expect(
			baseZone,
			`no zone in eslint.config.mjs has files ${JSON.stringify(BASE_ZONE_FILES)} — the global no-restricted-syntax zone moved or was renamed, so this guard is reading the wrong place`,
		).toBeDefined();

		const found = titleBanEntries(baseZone!.entries);
		expect(
			found.map((e) => e.selector),
			[
				`Expected exactly one no-restricted-syntax entry mentioning ${ISSUE_MARKER}`,
				"in the global zone of eslint.config.mjs (the JSX `title` attribute ban).",
				"",
				"Add it to baseRestrictedSyntax so every zone that spreads that array",
				"inherits it. Keep the issue marker in the message — this guard finds",
				"the entry by intent, not by matching the selector text.",
			].join("\n"),
		).toHaveLength(1);
	});

	it("the ban is present in every zone that configures no-restricted-syntax", () => {
		// eslint.config.mjs warns about this hazard in two places: a zone that
		// re-declares `no-restricted-syntax` SHADOWS the global one, silently
		// dropping every base selector for that zone. src/resolvers/**,
		// src/services/** and src/plugin.ts each re-declare it and spread
		// baseRestrictedSyntax back in; a future zone that forgets fails here.
		const missing = zones
			.filter((z) => titleBanEntries(z.entries).length === 0)
			.map((z) => JSON.stringify(z.files));

		expect(
			missing,
			[
				"Zone(s) configure no-restricted-syntax without the title-attribute ban.",
				"A zone-level no-restricted-syntax REPLACES the global one rather than",
				"merging, so these files silently lost the guard. Spread",
				"baseRestrictedSyntax into the zone's entry list.",
				"",
				`Missing in: ${missing.join(", ")}`,
			].join("\n"),
		).toEqual([]);
	});

	describe("fires on JSX title attributes", () => {
		for (const [name, code] of Object.entries(POSITIVE)) {
			it(name, () => {
				expect(shippedBan, "no shipped ban to test").toBeDefined();
				expect(
					violationsFor(shippedBan!.selector, code),
					`the ban did not flag a JSX title attribute:\n${code}`,
				).toBeGreaterThan(0);
			});
		}
	});

	describe("does not fire on lookalikes", () => {
		for (const [name, code] of Object.entries(NEGATIVE)) {
			it(name, () => {
				expect(shippedBan, "no shipped ban to test").toBeDefined();
				expect(
					violationsFor(shippedBan!.selector, code),
					`the ban flagged something that is not a JSX title attribute:\n${code}`,
				).toBe(0);
			});
		}
	});
});
