import {
	getAgentDir,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";

const CONFIG_VERSION = 1;
const CONFIG_FILE_NAME = "context-control.json";
const WIDE_LAYOUT_MIN_WIDTH = 92;
const PROJECT_CONTEXT_HEADER =
	"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
const PROJECT_CONTEXT_FOOTER = "</project_context>\n";

type ContextFile = NonNullable<BuildSystemPromptOptions["contextFiles"]>[number];
type ContextScope = "User" | "Inherited" | "Current project";
type PanelFocus = "list" | "preview";
type NarrowView = "list" | "preview";
type FlashKind = "success" | "warning" | "error";

interface ContextControlConfig {
	version: typeof CONFIG_VERSION;
	disabledPaths: string[];
}

interface ContextListItem {
	path: string;
	label: string;
	scope: ContextScope;
	content: string;
}

interface ListGroupRow {
	type: "group";
	key: string;
	scope: ContextScope;
	count: number;
	collapsed: boolean;
}

interface ListItemRow {
	type: "item";
	item: ContextListItem;
}

type ListRow = ListGroupRow | ListItemRow;

interface PreviewCache {
	path: string;
	width: number;
	lines: string[];
}

interface ContextUndoEntry {
	path: string;
	label: string;
	previousDisabled: boolean;
}

export type ContextControlPanelResult = { action: "close" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContextControlConfig(value: unknown): value is ContextControlConfig {
	return (
		isRecord(value) &&
		value.version === CONFIG_VERSION &&
		Array.isArray(value.disabledPaths) &&
		value.disabledPaths.every((path) => typeof path === "string")
	);
}

export function canonicalPath(filePath: string, cwd = process.cwd()): string {
	const absolutePath = normalize(resolve(cwd, filePath));
	try {
		return realpathSync.native(absolutePath);
	} catch {
		return absolutePath;
	}
}

function displayPath(filePath: string): string {
	const home = homedir();
	if (filePath === home) return "~";
	if (filePath.startsWith(`${home}${sep}`)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}m`;
}

function estimateTokens(content: string): number {
	let tokens = 0;
	for (const character of content) {
		tokens += (character.codePointAt(0) ?? 0) <= 127 ? 0.25 : 1;
	}
	return Math.ceil(tokens);
}

function lineCount(content: string): number {
	if (content.length === 0) return 0;
	return content.replace(/\r\n/g, "\n").split("\n").length;
}

export function renderProjectContext(contextFiles: readonly ContextFile[]): string {
	if (contextFiles.length === 0) return "";

	let section = PROJECT_CONTEXT_HEADER;
	for (const contextFile of contextFiles) {
		section += `<project_instructions path="${contextFile.path}">\n${contextFile.content}\n</project_instructions>\n\n`;
	}
	return `${section}${PROJECT_CONTEXT_FOOTER}`;
}

export function filterProjectContext(
	systemPrompt: string,
	contextFiles: readonly ContextFile[],
	disabledPaths: ReadonlySet<string>,
	cwd = process.cwd(),
): string {
	const enabledFiles = contextFiles.filter((file) => !disabledPaths.has(canonicalPath(file.path, cwd)));
	if (enabledFiles.length === contextFiles.length) return systemPrompt;

	const originalSection = renderProjectContext(contextFiles);
	const sectionIndex = systemPrompt.lastIndexOf(originalSection);
	if (sectionIndex === -1) return systemPrompt;

	const enabledSection = renderProjectContext(enabledFiles);
	return `${systemPrompt.slice(0, sectionIndex)}${enabledSection}${systemPrompt.slice(sectionIndex + originalSection.length)}`;
}

export function readConfig(configPath: string): { disabledPaths: Set<string>; error?: string } {
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (!isContextControlConfig(parsed)) {
			return {
				disabledPaths: new Set(),
				error: `Invalid context control config: ${configPath}`,
			};
		}
		return {
			disabledPaths: new Set(parsed.disabledPaths.map((path) => canonicalPath(path))),
		};
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { disabledPaths: new Set() };
		return {
			disabledPaths: new Set(),
			error: `Could not read context control config: ${configPath}`,
		};
	}
}

export function writeConfig(configPath: string, disabledPaths: ReadonlySet<string>): void {
	const config: ContextControlConfig = {
		version: CONFIG_VERSION,
		disabledPaths: [...disabledPaths].sort(),
	};
	const temporaryPath = `${configPath}.${process.pid}.tmp`;
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, configPath);
}

export function clonePaths(paths: ReadonlySet<string>): Set<string> {
	return new Set(paths);
}

export function replacePaths(target: Set<string>, source: ReadonlySet<string>): void {
	target.clear();
	for (const path of source) target.add(path);
}

export function pathsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const path of left) {
		if (!right.has(path)) return false;
	}
	return true;
}

export function changedPathCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	let count = 0;
	for (const path of new Set([...left, ...right])) {
		if (left.has(path) !== right.has(path)) count += 1;
	}
	return count;
}

function fuzzyMatchScore(value: string, query: string): number | undefined {
	const haystack = [...value.toLowerCase()];
	const needle = [...query.toLowerCase()];
	if (needle.length === 0) return Number.MAX_SAFE_INTEGER;

	let queryIndex = 0;
	let firstMatch = -1;
	let lastMatch = -1;
	for (let index = 0; index < haystack.length; index++) {
		if (haystack[index] !== needle[queryIndex]) continue;
		if (firstMatch < 0) firstMatch = index;
		lastMatch = index;
		queryIndex += 1;
		if (queryIndex !== needle.length) continue;

		const window = lastMatch - firstMatch + 1 - needle.length;
		return Math.max(0, window) - (firstMatch === 0 ? 100 : 0);
	}
	return undefined;
}

function contextSearchScore(item: ContextListItem, query: string): number | undefined {
	const scores = [fuzzyMatchScore(item.label, query), fuzzyMatchScore(item.path, query)].filter(
		(score): score is number => score !== undefined,
	);
	return scores.length > 0 ? Math.min(...scores) : undefined;
}

export class ContextControlPanel implements Component, Focusable {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #items: ContextListItem[];
	readonly #initialDisabledPaths: Set<string>;
	readonly #disabledPaths: Set<string>;
	readonly #onApply: (disabledPaths: Set<string>) => void;
	readonly #onDone: (result: ContextControlPanelResult) => void;

	#query = "";
	#filterEditing = false;
	#filterInput = new Input();
	#queryBeforeEdit = "";
	#selectedIndexBeforeFilter = 0;
	#selectedIndex = 0;
	#focus: PanelFocus = "list";
	#narrowView: NarrowView = "list";
	#previewOffset = 0;
	#lastWidth = 0;
	#lastPreviewLineCount = 0;
	#lastPreviewViewportHeight = 1;
	#previewCache: PreviewCache | undefined;
	#flash: { kind: FlashKind; text: string } | undefined;
	#confirmDiscard = false;
	#stateGuideOpen = false;
	#undoStack: ContextUndoEntry[] = [];
	#collapsedGroupKeys = new Set<string>();
	#focused = false;

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#filterInput.focused = value && this.#filterEditing;
	}

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		items: ContextListItem[];
		disabledPaths: ReadonlySet<string>;
		onApply: (disabledPaths: Set<string>) => void;
		onDone: (result: ContextControlPanelResult) => void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#items = options.items;
		this.#initialDisabledPaths = clonePaths(options.disabledPaths);
		this.#disabledPaths = clonePaths(options.disabledPaths);
		this.#onApply = options.onApply;
		this.#onDone = options.onDone;
		this.#selectedIndex = this.#firstItemRowIndex(this.#listRows());
		this.#selectedIndexBeforeFilter = this.#selectedIndex;
	}

	invalidate(): void {
		this.#previewCache = undefined;
		this.#filterInput.invalidate();
	}

	render(width: number): string[] {
		if (this.#confirmDiscard) {
			this.#lastWidth = width;
			return this.#renderDiscardDialog(width);
		}
		if (this.#stateGuideOpen) {
			this.#lastWidth = width;
			return this.#renderStateGuide(width);
		}
		const wasWide = this.#lastWidth >= WIDE_LAYOUT_MIN_WIDTH;
		const isWide = width >= WIDE_LAYOUT_MIN_WIDTH;
		if (this.#lastWidth > 0 && wasWide !== isWide) {
			if (isWide) this.#focus = this.#narrowView;
			else this.#narrowView = this.#focus;
		}
		this.#lastWidth = width;
		if (width < 4) return [truncateToWidth("Context", width, "")];
		return isWide ? this.#renderWide(width) : this.#renderNarrow(width);
	}

	handleInput(data: string): void {
		if (this.#confirmDiscard) {
			this.#handleDiscardInput(data);
			this.#requestRender();
			return;
		}
		if (this.#stateGuideOpen) {
			this.#handleStateGuideInput(data);
			this.#requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.#apply();
			return;
		}

		const wide = this.#lastWidth >= WIDE_LAYOUT_MIN_WIDTH;
		if (this.#filterEditing && this.#handleFilterInput(data, wide)) {
			this.#requestRender();
			return;
		}

		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			if (!wide && this.#narrowView === "preview") {
				this.#narrowView = "list";
				this.#focus = "list";
			} else if (this.#query.length > 0) {
				this.#clearFilter();
			} else if (this.#isDirty()) {
				this.#confirmDiscard = true;
			} else {
				this.#onDone({ action: "close" });
				return;
			}
			this.#requestRender();
			return;
		}
		if (data === "/") {
			this.#beginFilterEditing();
			this.#requestRender();
			return;
		}
		if (data === "?") {
			this.#stateGuideOpen = true;
			this.#flash = undefined;
			this.#requestRender();
			return;
		}

		const listActive = wide ? this.#focus === "list" : this.#narrowView === "list";
		const groupSelected = listActive && this.#currentGroup() !== undefined;
		if (matchesKey(data, Key.left) || data === "h") {
			if (groupSelected) this.#setCurrentGroupCollapsed(true);
			else this.#moveFocus(-1, wide);
			this.#requestRender();
			return;
		}
		if (matchesKey(data, Key.right) || data === "l") {
			if (groupSelected) this.#setCurrentGroupCollapsed(false);
			else this.#moveFocus(1, wide);
			this.#requestRender();
			return;
		}
		if (wide && matchesKey(data, Key.tab)) {
			this.#moveFocus(1, wide);
			this.#requestRender();
			return;
		}

		const previewActive = wide ? this.#focus === "preview" : this.#narrowView === "preview";
		if (previewActive) this.#handlePreviewInput(data, wide);
		else this.#handleListInput(data, wide);
		this.#requestRender();
	}

	#requestRender(): void {
		this.#tui.requestRender();
	}

	#beginFilterEditing(): void {
		this.#filterEditing = true;
		this.#queryBeforeEdit = this.#query;
		this.#selectedIndexBeforeFilter = this.#selectedIndex;
		this.#filterInput = new Input();
		if (this.#query) this.#filterInput.handleInput(this.#query);
		this.#filterInput.focused = this.#focused;
		this.#focus = "list";
		this.#narrowView = "list";
		this.#flash = undefined;
	}

	#commitFilterEditing(): void {
		this.#filterEditing = false;
		this.#filterInput.focused = false;
		this.#queryBeforeEdit = this.#query;
		this.#selectedIndexBeforeFilter = this.#selectedIndex;
		this.#flash = undefined;
	}

	#cancelFilterEditing(): void {
		this.#query = this.#queryBeforeEdit;
		this.#filterEditing = false;
		this.#filterInput.focused = false;
		this.#resetFilterNavigation(this.#selectedIndexBeforeFilter);
	}

	#clearFilter(): void {
		this.#query = "";
		this.#queryBeforeEdit = "";
		this.#resetFilterNavigation();
	}

	#syncFilterInput(): void {
		const query = this.#filterInput.getValue();
		if (query === this.#query) return;
		this.#query = query;
		this.#resetFilterNavigation();
	}

	#resetFilterNavigation(selectedIndex?: number): void {
		const rows = this.#listRows();
		const lastIndex = Math.max(0, rows.length - 1);
		this.#selectedIndex = selectedIndex === undefined
			? this.#firstItemRowIndex(rows)
			: Math.max(0, Math.min(selectedIndex, lastIndex));
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = undefined;
	}

	#handleFilterInput(data: string, wide: boolean): boolean {
		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#cancelFilterEditing();
		} else if (this.#keybindings.matches(data, "tui.select.confirm")) {
			this.#commitFilterEditing();
		} else if (this.#keybindings.matches(data, "tui.select.up")) {
			this.#moveSelection(-1);
		} else if (this.#keybindings.matches(data, "tui.select.down")) {
			this.#moveSelection(1);
		} else if (this.#keybindings.matches(data, "tui.select.pageUp")) {
			this.#setSelection(this.#selectedIndex - 8);
		} else if (this.#keybindings.matches(data, "tui.select.pageDown")) {
			this.#setSelection(this.#selectedIndex + 8);
		} else if (wide && matchesKey(data, Key.tab)) {
			this.#commitFilterEditing();
			this.#focus = "preview";
		} else {
			this.#filterInput.handleInput(data);
			this.#syncFilterInput();
		}
		return true;
	}

	#isDirty(): boolean {
		return !pathsEqual(this.#initialDisabledPaths, this.#disabledPaths);
	}

	#pendingCount(): number {
		return changedPathCount(this.#initialDisabledPaths, this.#disabledPaths);
	}

	#pendingText(): string {
		const pending = this.#pendingCount();
		return pending > 0 ? `Pending ${pending}` : "No pending changes";
	}

	#apply(): void {
		if (!this.#isDirty()) {
			this.#flash = { kind: "success", text: "No pending changes" };
			this.#requestRender();
			return;
		}

		const changeCount = this.#pendingCount();
		try {
			this.#onApply(clonePaths(this.#disabledPaths));
		} catch (error) {
			this.#flash = {
				kind: "error",
				text: error instanceof Error ? error.message : "Could not apply Context changes",
			};
			this.#requestRender();
			return;
		}

		replacePaths(this.#initialDisabledPaths, this.#disabledPaths);
		this.#undoStack.length = 0;
		this.#flash = {
			kind: "success",
			text: `Applied ${changeCount} Context ${changeCount === 1 ? "change" : "changes"} · No pending changes`,
		};
		this.#requestRender();
	}

	#isPathPending(path: string): boolean {
		return this.#initialDisabledPaths.has(path) !== this.#disabledPaths.has(path);
	}

	#rowStatus(item: ContextListItem): "Included" | "Excluded" | "Pending" {
		if (this.#isPathPending(item.path)) return "Pending";
		return this.#disabledPaths.has(item.path) ? "Excluded" : "Included";
	}

	#stateLabel(item: ContextListItem): "Included" | "Excluded" {
		return this.#disabledPaths.has(item.path) ? "Excluded" : "Included";
	}

	#sourceStatus(item: ContextListItem): string {
		if (this.#isPathPending(item.path)) {
			return this.#disabledPaths.has(item.path) ? "Pending exclusion" : "Pending reset";
		}
		return this.#disabledPaths.has(item.path) ? "Saved exclusion" : "Using default";
	}

	#changeCurrentItem(disabled: boolean): void {
		const item = this.#currentItem();
		if (!item) return;
		const currentDisabled = this.#disabledPaths.has(item.path);
		if (currentDisabled === disabled) {
			this.#flash = {
				kind: "success",
				text: `Already ${disabled ? "Excluded" : "Included (default)"} · ${this.#pendingText()}`,
			};
			return;
		}

		this.#undoStack.push({ path: item.path, label: item.label, previousDisabled: currentDisabled });
		if (disabled) this.#disabledPaths.add(item.path);
		else this.#disabledPaths.delete(item.path);

		const pending = this.#pendingCount();
		const before = currentDisabled ? "Excluded" : "Included";
		const after = disabled ? "Excluded" : "Included (default)";
		this.#flash = {
			kind: pending > 0 ? "warning" : "success",
			text: `${before} → ${after} · ${this.#pendingText()}`,
		};
	}

	#toggleCurrentItem(): void {
		const item = this.#currentItem();
		if (!item) return;
		this.#changeCurrentItem(!this.#disabledPaths.has(item.path));
	}

	#resetCurrentItem(): void {
		this.#changeCurrentItem(false);
	}

	#undoLatestChange(): void {
		const entry = this.#undoStack.pop();
		if (!entry) {
			this.#flash = { kind: "warning", text: "No Context changes to undo" };
			return;
		}
		const before = this.#disabledPaths.has(entry.path) ? "Excluded" : "Included";
		if (entry.previousDisabled) this.#disabledPaths.add(entry.path);
		else this.#disabledPaths.delete(entry.path);
		const after = entry.previousDisabled ? "Excluded" : "Included (default)";
		const pending = this.#pendingCount();
		this.#flash = {
			kind: pending > 0 ? "warning" : "success",
			text: `Undo ${entry.label}: ${before} → ${after} · ${this.#pendingText()}`,
		};
	}

	#handleDiscardInput(data: string): void {
		if (data.toLowerCase() === "y") {
			this.#onDone({ action: "close" });
			return;
		}
		if (
			data.toLowerCase() === "n" ||
			this.#keybindings.matches(data, "tui.select.cancel") ||
			this.#keybindings.matches(data, "tui.select.confirm")
		) {
			this.#confirmDiscard = false;
		}
	}

	#handleStateGuideInput(data: string): void {
		if (data === "?" || this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#stateGuideOpen = false;
		}
	}

	#renderStateGuide(width: number): string[] {
		if (width < 4) return [truncateToWidth("Context state", width, "")];
		const innerWidth = width - 2;
		const lines = this.#topBorder(width, "Context state guide");
		for (const line of wrapTextWithAnsi(
			this.#theme.fg(
				"muted",
				"Pi discovers Context files normally. Context Control can include each file or exclude it from future agent prompts.",
			),
			Math.max(1, innerWidth - 2),
		)) {
			lines.push(this.#fullLine(line, innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		lines.push(
			this.#fullLine(
				this.#joined(
					`${this.#theme.fg("accent", "●")}  ${this.#theme.fg("text", "Included")}`,
					this.#theme.fg("muted", "Added to the next agent prompt"),
					Math.max(0, innerWidth - 2),
				),
				innerWidth,
			),
		);
		lines.push(
			this.#fullLine(
				this.#joined(
					`${this.#theme.fg("dim", "○")}  ${this.#theme.fg("text", "Excluded")}`,
					this.#theme.fg("muted", "Removed from prompts; file unchanged"),
					Math.max(0, innerWidth - 2),
				),
				innerWidth,
			),
		);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help = width >= 76
			? "Space/Shift+Space toggle   r included   u undo   Esc close"
			: width >= 50
				? "Space toggle   r included   u undo   Esc close"
				: "Esc close";
		lines.push(this.#fullLine(this.#theme.fg("dim", help), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderDiscardDialog(width: number): string[] {
		if (width < 4) return [truncateToWidth("Discard changes?", width, "")];
		const innerWidth = width - 2;
		const pending = this.#pendingCount();
		const lines = this.#topBorder(width, "Unsaved Context changes");
		lines.push(
			this.#fullLine(
				this.#theme.fg("warning", `Discard ${pending} pending ${pending === 1 ? "change" : "changes"}?`),
				innerWidth,
			),
		);
		lines.push(this.#fullLine(this.#theme.fg("dim", "Y discard   N/Enter/Esc keep editing"), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#filteredItems(): ContextListItem[] {
		const normalizedQuery = this.#query.trim().toLowerCase();
		if (!normalizedQuery) return this.#items;
		return this.#items
			.map((item, index) => ({ item, index, score: contextSearchScore(item, normalizedQuery) }))
			.filter(
				(entry): entry is { item: ContextListItem; index: number; score: number } => entry.score !== undefined,
			)
			.sort((left, right) => left.score - right.score || left.index - right.index)
			.map((entry) => entry.item);
	}

	#buildListRows(items: ContextListItem[]): ListRow[] {
		const grouped = new Map<ContextScope, ContextListItem[]>();
		for (const item of items) {
			const existing = grouped.get(item.scope);
			if (existing) existing.push(item);
			else grouped.set(item.scope, [item]);
		}

		const rows: ListRow[] = [];
		const filtering = this.#query.trim().length > 0;
		for (const [scope, groupItems] of grouped) {
			const key = scope;
			const collapsed = !filtering && this.#collapsedGroupKeys.has(key);
			rows.push({ type: "group", key, scope, count: groupItems.length, collapsed });
			if (collapsed) continue;
			for (const item of groupItems) rows.push({ type: "item", item });
		}
		return rows;
	}

	#listRows(): ListRow[] {
		return this.#buildListRows(this.#filteredItems());
	}

	#rowKey(row: ListRow): string {
		return row.type === "group" ? `group:${row.key}` : `item:${row.item.path}`;
	}

	#selectedRow(): ListRow | undefined {
		const rows = this.#listRows();
		if (rows.length === 0) return undefined;
		return rows[Math.max(0, Math.min(this.#selectedIndex, rows.length - 1))];
	}

	#currentItem(): ContextListItem | undefined {
		const row = this.#selectedRow();
		return row?.type === "item" ? row.item : undefined;
	}

	#currentGroup(): ListGroupRow | undefined {
		const row = this.#selectedRow();
		return row?.type === "group" ? row : undefined;
	}

	#firstItemRowIndex(rows: ListRow[]): number {
		const index = rows.findIndex((row) => row.type === "item");
		return index >= 0 ? index : 0;
	}

	#moveSelection(delta: number): void {
		const rows = this.#listRows();
		if (rows.length === 0) return;
		this.#selectedIndex = (this.#selectedIndex + delta + rows.length) % rows.length;
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = undefined;
	}

	#setSelection(index: number): void {
		const rows = this.#listRows();
		if (rows.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(index, rows.length - 1));
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = undefined;
	}

	#moveFocus(delta: number, wide: boolean): void {
		const panes: PanelFocus[] = ["list", "preview"];
		const current = wide ? this.#focus : this.#narrowView;
		const currentIndex = panes.indexOf(current);
		const next = panes[(currentIndex + delta + panes.length) % panes.length] ?? "list";
		this.#focus = next;
		this.#narrowView = next;
		this.#flash = undefined;
	}

	#setCurrentGroupCollapsed(collapsed: boolean): void {
		const group = this.#currentGroup();
		if (!group) return;
		if (this.#query.trim()) {
			this.#flash = {
				kind: collapsed ? "warning" : "success",
				text: collapsed ? "Groups stay expanded while filtering" : `Already expanded ${group.scope}`,
			};
			return;
		}

		const currentlyCollapsed = this.#collapsedGroupKeys.has(group.key);
		if (currentlyCollapsed === collapsed) {
			this.#flash = {
				kind: "success",
				text: `Already ${collapsed ? "collapsed" : "expanded"} ${group.scope}`,
			};
			return;
		}

		if (collapsed) this.#collapsedGroupKeys.add(group.key);
		else this.#collapsedGroupKeys.delete(group.key);
		const rows = this.#listRows();
		const nextIndex = rows.findIndex((row) => this.#rowKey(row) === `group:${group.key}`);
		this.#selectedIndex = nextIndex >= 0 ? nextIndex : this.#firstItemRowIndex(rows);
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = {
			kind: "success",
			text: `${collapsed ? "Collapsed" : "Expanded"} ${group.scope} · ${group.count} ${group.count === 1 ? "file" : "files"}`,
		};
	}

	#toggleCurrentGroup(): void {
		const group = this.#currentGroup();
		if (!group) return;
		this.#setCurrentGroupCollapsed(!group.collapsed);
	}

	#handleListInput(data: string, wide: boolean): void {
		const rows = this.#listRows();
		if (this.#keybindings.matches(data, "tui.select.up") || data === "k") {
			this.#moveSelection(-1);
		} else if (this.#keybindings.matches(data, "tui.select.down") || data === "j") {
			this.#moveSelection(1);
		} else if (this.#keybindings.matches(data, "tui.select.pageUp")) {
			this.#setSelection(this.#selectedIndex - 8);
		} else if (this.#keybindings.matches(data, "tui.select.pageDown")) {
			this.#setSelection(this.#selectedIndex + 8);
		} else if (matchesKey(data, Key.home)) {
			this.#setSelection(0);
		} else if (matchesKey(data, Key.end)) {
			this.#setSelection(rows.length - 1);
		} else if (matchesKey(data, Key.shift("space"))) {
			this.#toggleCurrentItem();
		} else if (data === " ") {
			if (this.#currentGroup()) this.#toggleCurrentGroup();
			else this.#toggleCurrentItem();
		} else if (data === "r") {
			this.#resetCurrentItem();
		} else if (data === "u") {
			this.#undoLatestChange();
		} else if (this.#keybindings.matches(data, "tui.select.confirm")) {
			if (this.#currentGroup()) {
				this.#toggleCurrentGroup();
			} else if (!wide && this.#currentItem()) {
				this.#focus = "preview";
				this.#narrowView = "preview";
				this.#flash = undefined;
			}
		}
	}

	#handlePreviewInput(data: string, wide: boolean): void {
		const pageSize = Math.max(1, this.#lastPreviewViewportHeight - 1);
		if (this.#keybindings.matches(data, "tui.select.up") || data === "k") {
			this.#scrollPreview(-1);
		} else if (this.#keybindings.matches(data, "tui.select.down") || data === "j") {
			this.#scrollPreview(1);
		} else if (this.#keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) {
			this.#scrollPreview(-pageSize);
		} else if (this.#keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) {
			this.#scrollPreview(pageSize);
		} else if (matchesKey(data, Key.home)) {
			this.#previewOffset = 0;
		} else if (matchesKey(data, Key.end)) {
			this.#previewOffset = Math.max(0, this.#lastPreviewLineCount - this.#lastPreviewViewportHeight);
		} else if (!wide && this.#keybindings.matches(data, "tui.select.confirm")) {
			this.#narrowView = "list";
			this.#focus = "list";
		}
	}

	#scrollPreview(delta: number): void {
		const maximum = Math.max(0, this.#lastPreviewLineCount - this.#lastPreviewViewportHeight);
		this.#previewOffset = Math.max(0, Math.min(this.#previewOffset + delta, maximum));
		this.#flash = undefined;
	}

	#pad(text: string, width: number): string {
		const clipped = truncateToWidth(text, Math.max(0, width), "");
		return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
	}

	#selectedBackground(content: string): string {
		return content
			.split("\x1b[0m")
			.map((segment) => this.#theme.bg("selectedBg", segment))
			.join("\x1b[0m");
	}

	#joined(left: string, right: string, width: number): string {
		const gap = 2;
		const rightWidth = visibleWidth(right);
		const leftWidth = Math.max(0, width - rightWidth - gap);
		const clippedLeft = truncateToWidth(left, leftWidth, "…");
		return `${clippedLeft}${" ".repeat(Math.max(gap, width - visibleWidth(clippedLeft) - rightWidth))}${right}`;
	}

	#border(left: string, middle: string, right: string, innerWidth: number): string {
		return this.#theme.fg("borderMuted", `${left}${middle.repeat(Math.max(0, innerWidth))}${right}`);
	}

	#topBorder(width: number, titleText: string): string[] {
		const innerWidth = width - 2;
		const title = ` ${titleText} `;
		if (visibleWidth(title) + 3 > width) {
			return [
				this.#border("╭", "─", "╮", innerWidth),
				this.#fullLine(this.#theme.fg("accent", this.#theme.bold(titleText)), innerWidth),
			];
		}
		const fill = Math.max(0, innerWidth - visibleWidth(title) - 1);
		return [
			`${this.#theme.fg("borderMuted", "╭─")}${this.#theme.fg("accent", this.#theme.bold(title))}${this.#theme.fg(
				"borderMuted",
				`${"─".repeat(fill)}╮`,
			)}`,
		];
	}

	#fullLine(content: string, innerWidth: number, selected = false): string {
		const padded = this.#pad(` ${content}`, innerWidth);
		const body = selected ? this.#selectedBackground(padded) : padded;
		return `${this.#theme.fg("borderMuted", "│")}${body}${this.#theme.fg("borderMuted", "│")}`;
	}

	#paneContent(content: string, width: number, selected = false): string {
		const padded = this.#pad(` ${content}`, width);
		return selected ? this.#selectedBackground(padded) : padded;
	}

	#maximumOverlayHeight(): number {
		return Math.max(1, Math.floor(this.#tui.terminal.rows * 0.9));
	}

	#preferredOverlayHeight(): number {
		return Math.max(1, Math.min(this.#maximumOverlayHeight(), Math.floor(this.#tui.terminal.rows * 0.78)));
	}

	#summary(): string {
		const includedCount = this.#items.filter((item) => !this.#disabledPaths.has(item.path)).length;
		const excludedCount = this.#items.length - includedCount;
		const parts = [
			this.#theme.fg("accent", `● ${includedCount} Included`),
			this.#theme.fg(excludedCount > 0 ? "warning" : "dim", `○ ${excludedCount} Excluded`),
		];
		return parts.join(this.#theme.fg("dim", "  ·  "));
	}

	#searchValue(width: number): string {
		if (this.#filterEditing) {
			const inputWidth = this.#labeledValueWidth(width);
			const rendered = this.#filterInput.render(inputWidth + 2)[0] ?? "> ";
			return (rendered.startsWith("> ") ? rendered.slice(2) : rendered).trimEnd();
		}
		if (this.#query) return this.#theme.fg("text", this.#query);
		const placeholder = width >= 42 ? " to filter paths" : " filter";
		return `${this.#theme.fg("accent", "/")}${this.#theme.fg("dim", placeholder)}`;
	}

	#sectionSegment(label: string, width: number, focused: boolean): string {
		if (width <= 0) return "";
		const prefix = "─ ";
		const suffix = " ";
		const titleWidth = visibleWidth(prefix) + visibleWidth(label) + visibleWidth(suffix);
		const styledLabel = focused
			? this.#theme.fg("accent", this.#theme.bold(label))
			: this.#theme.fg("muted", label);
		const fill = Math.max(0, width - titleWidth);
		return `${this.#theme.fg("borderMuted", prefix)}${styledLabel}${this.#theme.fg(
			"borderMuted",
			`${suffix}${"─".repeat(fill)}`,
		)}`;
	}

	#visibleListRows(height: number): ListRow[] {
		const rows = this.#listRows();
		if (rows.length <= height) return rows;

		const selectedRow = Math.max(0, Math.min(this.#selectedIndex, rows.length - 1));
		const start = Math.max(0, Math.min(selectedRow - Math.floor(height / 2), rows.length - height));
		const visible = rows.slice(start, start + height);
		if (start > 0 && visible[0]?.type === "item") {
			const availableRows = height - 1;
			const stickyStart = Math.max(
				0,
				Math.min(selectedRow - Math.floor(availableRows / 2), rows.length - availableRows),
			);
			const stickyRows = rows.slice(stickyStart, stickyStart + availableRows);
			const firstRow = stickyRows[0];
			if (firstRow?.type === "item") {
				let groupIndex = stickyStart - 1;
				while (groupIndex >= 0 && rows[groupIndex]?.type !== "group") groupIndex -= 1;
				const group = rows[groupIndex];
				if (group?.type === "group") return [group, ...stickyRows];
			}
			return rows.slice(stickyStart, stickyStart + height);
		}
		return visible;
	}

	#renderListRows(width: number, height: number, focused: boolean): string[] {
		const items = this.#filteredItems();
		if (items.length === 0) {
			const message = this.#items.length === 0
				? "No Context instruction files discovered."
				: `No paths match “${this.#query}”.`;
			return [
				this.#paneContent(this.#theme.fg("muted", message), width),
				...Array.from({ length: height - 1 }, () => " ".repeat(width)),
			];
		}

		const rows = this.#visibleListRows(height);
		const selectedRow = this.#selectedRow();
		const selectedKey = selectedRow ? this.#rowKey(selectedRow) : undefined;
		const rendered = rows.map((row) => {
			if (row.type === "group") {
				const selected = this.#rowKey(row) === selectedKey;
				const icon = row.collapsed ? "▸" : "▾";
				const label = selected
					? this.#theme.fg("accent", this.#theme.bold(row.scope))
					: this.#theme.fg("muted", row.scope);
				return this.#paneContent(
					`${this.#theme.fg("muted", icon)} ${label} ${this.#theme.fg("muted", `(${row.count})`)}`,
					width,
					selected && focused,
				);
			}

			const selected = this.#rowKey(row) === selectedKey;
			const disabled = this.#disabledPaths.has(row.item.path);
			const status = this.#rowStatus(row.item);
			const icon = disabled ? this.#theme.fg("dim", "○") : this.#theme.fg("accent", "●");
			const label = selected
				? this.#theme.fg("accent", this.#theme.bold(row.item.label))
				: disabled
					? this.#theme.fg("dim", row.item.label)
					: this.#theme.fg("text", row.item.label);
			const badge = this.#theme.fg(
				status === "Pending" ? "warning" : status === "Excluded" ? "muted" : "dim",
				status,
			);
			const content = this.#joined(`  ${icon}  ${label}`, badge, Math.max(0, width - 2));
			return this.#paneContent(content, width, selected && focused);
		});
		while (rendered.length < height) rendered.push(" ".repeat(width));
		return rendered.slice(0, height);
	}

	#previewLines(item: ContextListItem, width: number): string[] {
		const contentWidth = Math.max(1, width);
		if (this.#previewCache?.path === item.path && this.#previewCache.width === contentWidth) {
			return this.#previewCache.lines;
		}
		if (item.content.length === 0) {
			this.#previewCache = { path: item.path, width: contentWidth, lines: [] };
			return [];
		}

		const lines: string[] = [];
		let inCodeFence = false;
		for (const sourceLine of item.content.replace(/\r\n/g, "\n").split("\n")) {
			const expanded = sourceLine.replace(/\t/g, "    ");
			const isFence = /^\s*```/.test(expanded);
			let styled = expanded;
			if (inCodeFence || isFence) styled = this.#theme.fg("mdCodeBlock", expanded);
			else if (/^#{1,6}\s/.test(expanded)) styled = this.#theme.fg("mdHeading", this.#theme.bold(expanded));
			else if (/^\s*>/.test(expanded)) styled = this.#theme.fg("mdQuote", expanded);
			else styled = this.#theme.fg("text", expanded);

			const wrapped = expanded.length === 0 ? [""] : wrapTextWithAnsi(styled, contentWidth);
			lines.push(...wrapped);
			if (isFence) inCodeFence = !inCodeFence;
		}
		this.#previewCache = { path: item.path, width: contentWidth, lines };
		return lines;
	}

	#labelWidth(width: number): number {
		return width >= 30 ? Math.min(10, width - 1) : 0;
	}

	#labeledValueWidth(width: number): number {
		const contentWidth = Math.max(1, width);
		const labelWidth = this.#labelWidth(contentWidth);
		if (labelWidth > 0) return Math.max(1, contentWidth - labelWidth);
		const indent = Math.min(2, Math.max(0, contentWidth - 1));
		return Math.max(1, contentWidth - indent);
	}

	#labelPrefix(label: string, width: number): string {
		if (width <= 0) return "";
		const gap = Math.min(2, width);
		const textWidth = Math.max(0, width - gap);
		const clipped = truncateToWidth(label, textWidth, "");
		const padded = `${clipped}${" ".repeat(Math.max(0, textWidth - visibleWidth(clipped)))}`;
		return `${this.#theme.fg("muted", padded)}${" ".repeat(gap)}`;
	}

	#labeledTextLines(label: string, value: string, width: number): string[] {
		const contentWidth = Math.max(1, width);
		const labelWidth = this.#labelWidth(contentWidth);
		if (labelWidth === 0) {
			const indent = Math.min(2, Math.max(0, contentWidth - 1));
			const valueWidth = Math.max(1, contentWidth - indent);
			return [
				...wrapTextWithAnsi(this.#theme.fg("muted", label), contentWidth),
				...wrapTextWithAnsi(value, valueWidth).map((line) => `${" ".repeat(indent)}${line}`),
			];
		}

		const valueWidth = Math.max(1, contentWidth - labelWidth);
		const valueLines = wrapTextWithAnsi(value, valueWidth);
		return (valueLines.length > 0 ? valueLines : [""]).map(
			(line, index) => `${this.#labelPrefix(index === 0 ? label : "", labelWidth)}${line}`,
		);
	}

	#stateSummary(item: ContextListItem): string {
		const state = this.#stateLabel(item);
		const source = this.#sourceStatus(item);
		const sourceColor = this.#isPathPending(item.path)
			? "warning"
			: this.#disabledPaths.has(item.path)
				? "muted"
				: "dim";
		return `${this.#theme.fg("muted", `Current ${state} · Default Included · `)}${this.#theme.fg(sourceColor, source)}`;
	}

	#itemDetailLines(item: ContextListItem, width: number): string[] {
		const bytes = new TextEncoder().encode(item.content).length;
		const metadata = `${lineCount(item.content)} lines · ${formatBytes(bytes)} · ~${formatCount(estimateTokens(item.content))} tokens`;
		return [
			...this.#labeledTextLines("Path", this.#theme.fg("text", item.label), width),
			...this.#labeledTextLines("Scope", this.#theme.fg("muted", item.scope), width),
			...this.#labeledTextLines("State", this.#stateSummary(item), width),
			...this.#labeledTextLines("Size", this.#theme.fg("dim", metadata), width),
		];
	}

	#groupAction(group: ListGroupRow): string {
		return group.collapsed
			? "l to expand this group · Space/Enter to toggle."
			: "h to collapse this group · Space/Enter to toggle.";
	}

	#groupDetailLines(group: ListGroupRow, width: number): string[] {
		const state = group.collapsed ? "Collapsed" : "Expanded";
		return [
			...this.#labeledTextLines("Group", this.#theme.fg("text", group.scope), width),
			...this.#labeledTextLines("Files", this.#theme.fg("muted", String(group.count)), width),
			...this.#labeledTextLines("State", this.#theme.fg("accent", state), width),
			...wrapTextWithAnsi(this.#theme.fg("dim", this.#groupAction(group)), width),
		];
	}

	#renderGroupPreviewRows(group: ListGroupRow, width: number, height: number): string[] {
		const lines = this.#groupDetailLines(group, Math.max(1, width - 2));
		this.#lastPreviewLineCount = lines.length;
		this.#lastPreviewViewportHeight = height;
		this.#previewOffset = Math.max(0, Math.min(this.#previewOffset, Math.max(0, lines.length - height)));
		const rows = lines
			.slice(this.#previewOffset, this.#previewOffset + height)
			.map((line) => this.#paneContent(line, width));
		while (rows.length < height) rows.push(" ".repeat(width));
		return rows;
	}

	#renderPreviewRows(width: number, height: number): string[] {
		const group = this.#currentGroup();
		if (group) return this.#renderGroupPreviewRows(group, width, height);

		const item = this.#currentItem();
		if (!item) {
			const message = this.#items.length === 0
				? "No Context content to preview."
				: "Press / to change the filter.";
			return [
				this.#paneContent(this.#theme.fg("muted", message), width),
				...Array.from({ length: height - 1 }, () => " ".repeat(width)),
			];
		}

		const detailLines = this.#itemDetailLines(item, Math.max(1, width - 2));
		const details = detailLines.map((line) => this.#paneContent(line, width));
		const previewHeight = Math.max(1, height - details.length - 1);
		const contentWidth = Math.max(1, width - 2);
		const previewLines = this.#previewLines(item, contentWidth);
		this.#lastPreviewLineCount = previewLines.length;
		this.#lastPreviewViewportHeight = previewHeight;
		this.#previewOffset = Math.max(
			0,
			Math.min(this.#previewOffset, Math.max(0, previewLines.length - previewHeight)),
		);

		const position = previewLines.length === 0
			? ""
			: ` · View ${this.#previewOffset + 1}–${Math.min(this.#previewOffset + previewHeight, previewLines.length)} of ${previewLines.length}`;
		const dividerWidth = Math.max(0, width - 2);
		const dividerLabel = truncateToWidth(
			`${this.#theme.fg("borderMuted", "─ ")}${this.#theme.fg("accent", this.#theme.bold("Content"))}${this.#theme.fg("dim", position)}${this.#theme.fg("borderMuted", " ")}`,
			dividerWidth,
			"…",
		);
		const separator = this.#paneContent(
			`${dividerLabel}${this.#theme.fg("borderMuted", "─".repeat(Math.max(0, dividerWidth - visibleWidth(dividerLabel))))}`,
			width,
		);
		const content = previewLines.length === 0
			? [this.#paneContent(this.#theme.fg("warning", "This file is empty."), width)]
			: previewLines
					.slice(this.#previewOffset, this.#previewOffset + previewHeight)
					.map((line) => this.#paneContent(line, width));
		const rows = [...details, separator, ...content];
		while (rows.length < height) rows.push(" ".repeat(width));
		return rows.slice(0, height);
	}

	#helpWithFlash(help: string, width: number): string {
		const styledHelp = this.#theme.fg("dim", help);
		if (!this.#flash) return styledHelp;
		const flashColor = this.#flash.kind === "error" ? "error" : this.#flash.kind === "warning" ? "warning" : "success";
		const styledFlash = this.#theme.fg(flashColor, this.#flash.text);
		if (this.#flash.kind === "error") return styledFlash;
		return this.#joined(styledHelp, styledFlash, width);
	}

	#wideListHelp(width: number): string {
		if (this.#currentGroup()) {
			return width >= 112
				? "j/k  h collapse  l expand  Space/Enter toggle  Tab preview  / filter  ? guide  Ctrl+S apply"
				: "j/k  h collapse  l expand  Space/Enter toggle  / filter";
		}
		return width >= 112
			? "j/k select  h/l focus  / filter  Space toggle  r included  u undo  ? guide  Ctrl+S apply"
			: "j/k select  h/l focus  / filter  Space toggle  r/u";
	}

	#narrowListHelp(width: number): string {
		if (this.#currentGroup()) {
			return width >= 68
				? "j/k  h collapse  l expand  Space/Enter toggle  / filter"
				: "j/k  h fold  l open  Space/Enter";
		}
		return width >= 68
			? "j/k  Enter preview  h/l focus  / filter  Space  r/u"
			: width >= 50
				? "j/k  Enter preview  h/l  / filter"
				: "j/k  Enter preview  h/l focus";
	}

	#renderWide(width: number): string[] {
		const innerWidth = width - 2;
		const headerWidth = Math.max(1, innerWidth - 2);
		const listWidth = Math.min(44, Math.max(32, Math.floor(innerWidth * 0.38)));
		const previewWidth = innerWidth - listWidth - 1;
		const lines = this.#topBorder(width, "Context");
		for (const summaryLine of this.#labeledTextLines("State", this.#summary(), headerWidth)) {
			lines.push(this.#fullLine(summaryLine, innerWidth));
		}
		for (const searchLine of this.#labeledTextLines("Filter", this.#searchValue(headerWidth), headerWidth)) {
			lines.push(this.#fullLine(searchLine, innerWidth));
		}
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Files", listWidth, this.#focus === "list")}${this.#theme.fg(
				"borderMuted",
				"┬",
			)}${this.#sectionSegment("Preview", previewWidth, this.#focus === "preview")}${this.#theme.fg("borderMuted", "┤")}`,
		);

		const contentHeight = Math.max(4, Math.min(30, this.#preferredOverlayHeight() - lines.length - 2));
		const listRows = this.#renderListRows(listWidth, contentHeight, this.#focus === "list");
		const previewRows = this.#renderPreviewRows(previewWidth, contentHeight);
		for (let index = 0; index < contentHeight; index++) {
			lines.push(
				`${this.#theme.fg("borderMuted", "│")}${listRows[index]}${this.#theme.fg("borderMuted", "│")}${previewRows[index]}${this.#theme.fg(
					"borderMuted",
					"│",
				)}`,
			);
		}
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#theme.fg("borderMuted", "─".repeat(listWidth))}${this.#theme.fg(
				"borderMuted",
				"┴",
			)}${this.#theme.fg("borderMuted", "─".repeat(previewWidth))}${this.#theme.fg("borderMuted", "┤")}`,
		);
		const help = this.#filterEditing
			? "Type filter   ←/→ cursor   ↑/↓ select   Ctrl+U clear   Ctrl+W word   Enter keep   Esc cancel"
			: this.#focus === "list"
				? this.#wideListHelp(width)
				: width >= 100
					? "j/k/PgUp/PgDn scroll   h/l focus   / filter   ? guide   Ctrl+S apply   Esc close"
					: "j/k/Pg scroll   h/l focus   / filter   Ctrl+S apply   Esc close";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderNarrow(width: number): string[] {
		return this.#narrowView === "preview" ? this.#renderNarrowPreview(width) : this.#renderNarrowList(width);
	}

	#renderNarrowList(width: number): string[] {
		const innerWidth = width - 2;
		const headerWidth = Math.max(1, innerWidth - 2);
		const lines = this.#topBorder(width, "Context");
		for (const summaryLine of this.#labeledTextLines("State", this.#summary(), headerWidth)) {
			lines.push(this.#fullLine(summaryLine, innerWidth));
		}
		for (const searchLine of this.#labeledTextLines("Filter", this.#searchValue(headerWidth), headerWidth)) {
			lines.push(this.#fullLine(searchLine, innerWidth));
		}
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Files", innerWidth, true)}${this.#theme.fg("borderMuted", "┤")}`,
		);

		const item = this.#currentItem();
		const group = this.#currentGroup();
		const detailWidth = Math.max(1, innerWidth - 2);
		const detailLines = item
			? [
					...this.#labeledTextLines("Path", this.#theme.fg("text", item.label), detailWidth),
					...this.#labeledTextLines("State", this.#stateSummary(item), detailWidth),
				]
			: group
				? this.#groupDetailLines(group, detailWidth)
				: [this.#theme.fg("dim", "Press / to change the filter."), ""];
		const contentHeight = Math.max(
			3,
			Math.min(16, this.#preferredOverlayHeight() - lines.length - detailLines.length - 4),
		);
		const listRows = this.#renderListRows(innerWidth, contentHeight, true);
		for (const row of listRows) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		for (const detailLine of detailLines) lines.push(this.#fullLine(detailLine, innerWidth));
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help = this.#filterEditing
			? width >= 72
				? "Type filter  ←/→ cursor  ↑/↓ select  Ctrl+U clear  Ctrl+W word  Enter keep  Esc cancel"
				: width >= 52
					? "Type filter  Ctrl+U clear  Ctrl+W word  Enter keep  Esc cancel"
					: "Type filter  Enter keep  Esc cancel"
			: this.#narrowListHelp(width);
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderNarrowPreview(width: number): string[] {
		const innerWidth = width - 2;
		const lines = this.#topBorder(width, "Context preview");
		const contentHeight = Math.max(5, Math.min(24, this.#preferredOverlayHeight() - lines.length - 4));
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Full file", innerWidth, true)}${this.#theme.fg("borderMuted", "┤")}`,
		);
		const previewRows = this.#renderPreviewRows(innerWidth, contentHeight);
		for (const row of previewRows) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help = width >= 68
			? "j/k/Pg scroll  h/l focus  / filter  Ctrl+S apply  Esc back"
			: width >= 48
				? "j/k scroll  h/l focus  / filter  Esc back"
				: "j/k scroll  h/l focus  Esc back";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}
}

export default function contextControlExtension(pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const disabledPaths = new Set<string>();
	let configError: string | undefined;
	let promptMismatchWarningShown = false;

	const loadConfiguration = () => {
		const loadedConfig = readConfig(configPath);
		replacePaths(disabledPaths, loadedConfig.disabledPaths);
		configError = loadedConfig.error;
	};

	loadConfiguration();

	pi.on("session_start", (_event, ctx) => {
		loadConfiguration();
		if (configError) ctx.ui.notify(configError, "error");
	});

	pi.registerCommand("context", {
		description: "Enable or disable loaded Context instruction files",
		handler: async (args, ctx) => {
			if (args.trim() !== "") {
				ctx.ui.notify("Usage: /context", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/context requires TUI mode", "error");
				return;
			}
			if (configError) {
				ctx.ui.notify(configError, "error");
				return;
			}

			const contextFiles = ctx.getSystemPromptOptions().contextFiles ?? [];
			const cwd = canonicalPath(ctx.cwd);
			const agentDir = canonicalPath(getAgentDir());
			const items: ContextListItem[] = contextFiles.map((file) => {
				const path = canonicalPath(file.path, ctx.cwd);
				const parentDirectory = dirname(path);
				const scope: ContextScope = parentDirectory === agentDir
					? "User"
					: parentDirectory === cwd
						? "Current project"
						: "Inherited";
				return { path, label: displayPath(path), scope, content: file.content };
			});

			await ctx.ui.custom<ContextControlPanelResult>(
				(tui, theme, keybindings, done) =>
					new ContextControlPanel({
						tui,
						theme,
						keybindings,
						items,
						disabledPaths,
							onApply: (nextDisabledPaths) => {
							try {
								if (!pathsEqual(disabledPaths, nextDisabledPaths)) {
									writeConfig(configPath, nextDisabledPaths);
								}
								replacePaths(disabledPaths, nextDisabledPaths);
								configError = undefined;
							} catch {
								configError = `Could not write context control config: ${configPath}`;
								throw new Error(configError);
							}
						},
						onDone: done,
					}),
				{
					overlay: true,
					overlayOptions: {
						width: 120,
						minWidth: 36,
						maxHeight: "90%",
						anchor: "center",
						margin: 1,
					},
				},
			);
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (disabledPaths.size === 0) return;

		const contextFiles = event.systemPromptOptions.contextFiles ?? [];
		const filteredPrompt = filterProjectContext(event.systemPrompt, contextFiles, disabledPaths, ctx.cwd);
		const hasDisabledLoadedFile = contextFiles.some((file) => disabledPaths.has(canonicalPath(file.path, ctx.cwd)));

		if (filteredPrompt === event.systemPrompt) {
			if (hasDisabledLoadedFile && !promptMismatchWarningShown) {
				promptMismatchWarningShown = true;
				ctx.ui.notify("Context control could not locate Pi's project context section.", "warning");
			}
			return;
		}

		promptMismatchWarningShown = false;
		return { systemPrompt: filteredPrompt };
	});
}
