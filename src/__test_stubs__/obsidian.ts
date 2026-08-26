/**
 * Minimal `obsidian` module stub for unit tests.
 *
 * The real `obsidian` package on npm is types-only (`"main": ""`); the
 * runtime is provided by Obsidian itself. Tests that import from
 * `obsidian` get this stub via the alias in `vitest.config.ts`.
 *
 * Add new exports here as new test files require them. Each export should
 * be the smallest viable stub — just enough for the source file under test
 * to instantiate / render without throwing.
 *
 * Tests that exercise specific Obsidian API surfaces should `vi.mock("obsidian", ...)`
 * within the test file to override these defaults with assertions.
 */

import { vi } from "vitest";

export class TAbstractFile {
	path = "";
}

export class TFile extends TAbstractFile {
	basename = "";
	extension = "md";
	stat = { ctime: 0, mtime: 0, size: 0 };
}

export const setIcon = vi.fn();

// Minimal prepareFuzzySearch stub: substring match, score = -len (shorter
// labels rank higher), matches[] unused by our ranker. Mirrors the real
// signature `(query) => (text) => SearchResult | null`.
export const prepareFuzzySearch = (query: string) => (text: string) =>
	text.toLowerCase().includes(query.toLowerCase())
		? { score: -text.length, matches: [] as number[][] }
		: null;

/**
 * Mirrors the real `setTooltip`, which is implemented by setting **aria-label**
 * and nothing else (verified against the running app 2026-08-25). A no-op stub
 * here is what let the label-in-name regression class (A2UI-I08 / I199) pass
 * unit tests: tooltip text never reached the DOM, so no test could assert the
 * accessible name it produces. Still a vi.fn, so existing
 * `toHaveBeenCalledWith` assertions keep working.
 */
export const setTooltip = vi.fn((el: HTMLElement, tooltip: string) => {
	el.setAttribute("aria-label", tooltip);
});

export const MarkdownRenderer = {
	render: vi.fn(),
	renderMarkdown: vi.fn(),
};

export class Component {
	load() {}
	unload() {}
	registerEvent() {}
	registerDomEvent() {}
	addChild() {}
	removeChild() {}
}

export class Modal {
	open() {}
	close() {}
}

export class App {
	scope = new Scope();
	keymap = {
		pushScope: vi.fn(),
		popScope: vi.fn(),
	};
}

export class Scope {
	register(
		_modifiers: string[],
		_key: string | null,
		_callback: unknown,
	): unknown {
		return {};
	}
}

export class FuzzySuggestModal<T> {
	app: App;
	scope = new Scope();
	constructor(app: App) {
		this.app = app;
	}
	setPlaceholder(_placeholder: string): void {}
	getItems(): T[] {
		return [];
	}
	getItemText(_item: T): string {
		return "";
	}
	onChooseItem(_item: T, _evt?: MouseEvent | KeyboardEvent): void {}
	open() {}
	close() {}
}

export class Notice {
	/** Messages/fragments passed to the constructor, for test assertions. */
	static instances: Notice[] = [];
	message: string | DocumentFragment;
	duration: number | undefined;
	hidden = false;
	constructor(message: string | DocumentFragment, duration?: number) {
		this.message = message;
		this.duration = duration;
		Notice.instances.push(this);
	}
	hide(): void {
		this.hidden = true;
	}
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
};

export const Keymap = {
	/** Mirrors Obsidian: ⌘/⌃ or a middle-click → a pane type ("tab"); else false. */
	isModEvent(evt?: MouseEvent | KeyboardEvent | null): string | boolean {
		if (!evt) return false;
		const middleClick = (evt as MouseEvent).button === 1;
		return evt.metaKey || evt.ctrlKey || middleClick ? "tab" : false;
	},
};

export class FileSystemAdapter {
	getBasePath() {
		return "";
	}
}

export function getLanguage(): string {
	return "en";
}
