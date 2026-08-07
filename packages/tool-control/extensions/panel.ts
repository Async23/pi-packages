import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
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
import { homedir } from "node:os";
import {
	changedToolCount,
	displaySourcePath,
	toolNameSetsEqual,
	type ToolCatalogItem,
	type ToolSourceKind,
} from "./policy.ts";

const WIDE_LAYOUT_MIN_WIDTH = 92;

type PanelFocus = "list" | "details";
type NarrowView = "list" | "details";
type FlashKind = "success" | "warning" | "error";

interface SourceTab {
	id: "all" | ToolSourceKind;
	label: string;
}

const SOURCE_TABS: SourceTab[] = [
	{ id: "all", label: "ALL" },
	{ id: "builtin", label: "Built-in" },
	{ id: "mcp", label: "MCP" },
	{ id: "extension", label: "Extension" },
	{ id: "sdk", label: "SDK" },
];

interface GroupRow {
	type: "group";
	key: string;
	label: string;
	sourceKind: ToolSourceKind;
	visibleCount: number;
	totalCount: number;
	collapsed: boolean;
}

interface ItemRow {
	type: "item";
	item: ToolCatalogItem;
}

type ListRow = GroupRow | ItemRow;

interface UndoEntry {
	label: string;
	previousInactiveByName: Map<string, boolean>;
}

export interface ToolControlApplyResult {
	items: ToolCatalogItem[];
	activeToolNames: ReadonlySet<string>;
	inactiveToolNames: ReadonlySet<string>;
}

export type ToolControlPanelResult = { action: "close" };

function fuzzyMatch(value: string, query: string): boolean {
	const haystack = [...value.toLowerCase()];
	const needle = [...query.trim().toLowerCase()];
	if (needle.length === 0) return true;
	let queryIndex = 0;
	for (const character of haystack) {
		if (character !== needle[queryIndex]) continue;
		queryIndex += 1;
		if (queryIndex === needle.length) return true;
	}
	return false;
}

function cloneNames(values: ReadonlySet<string>): Set<string> {
	return new Set(values);
}

function sourceCount(items: readonly ToolCatalogItem[], source: SourceTab["id"]): number {
	return source === "all" ? items.length : items.filter((item) => item.sourceKind === source).length;
}

function orderedSourceTabs(items: readonly ToolCatalogItem[]): Array<{ tab: SourceTab; index: number; count: number }> {
	const [all, ...sources] = SOURCE_TABS.map((tab, index) => ({ tab, index, count: sourceCount(items, tab.id) }));
	if (!all) return [];
	return [all, ...sources.filter(({ count }) => count > 0), ...sources.filter(({ count }) => count === 0)];
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

export class ToolControlPanel implements Component, Focusable {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #onApply: (inactiveToolNames: Set<string>) => ToolControlApplyResult;
	readonly #onDone: (result: ToolControlPanelResult) => void;

	#items: ToolCatalogItem[];
	#currentActiveToolNames: Set<string>;
	#initialInactiveToolNames: Set<string>;
	#inactiveToolNames: Set<string>;
	#query = "";
	#filterEditing = false;
	#filterInput = new Input();
	#queryBeforeEdit = "";
	#selectedIndexBeforeFilter = 0;
	#sourceTabIndex = 0;
	#selectedIndex = 0;
	#focus: PanelFocus = "list";
	#narrowView: NarrowView = "list";
	#detailsOffset = 0;
	#lastDetailsLineCount = 0;
	#lastDetailsViewportHeight = 1;
	#lastWidth = 0;
	#flash: { kind: FlashKind; text: string } | undefined;
	#confirmDiscard = false;
	#stateGuideOpen = false;
	#undoStack: UndoEntry[] = [];
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
		items: ToolCatalogItem[];
		activeToolNames: ReadonlySet<string>;
		inactiveToolNames: ReadonlySet<string>;
		onApply: (inactiveToolNames: Set<string>) => ToolControlApplyResult;
		onDone: (result: ToolControlPanelResult) => void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#items = options.items;
		this.#currentActiveToolNames = cloneNames(options.activeToolNames);
		this.#initialInactiveToolNames = cloneNames(options.inactiveToolNames);
		this.#inactiveToolNames = cloneNames(options.inactiveToolNames);
		this.#onApply = options.onApply;
		this.#onDone = options.onDone;
		this.#selectedIndex = this.#firstItemRowIndex(this.#listRows());
		this.#selectedIndexBeforeFilter = this.#selectedIndex;
	}

	invalidate(): void {
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
		if (width < 4) return [truncateToWidth("Tools", width, "")];
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
			if (!wide && this.#narrowView === "details") {
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
		if (data === "[" || data === "]") {
			this.#cycleSource(data === "]" ? 1 : -1);
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

		const detailsActive = wide ? this.#focus === "details" : this.#narrowView === "details";
		if (detailsActive) this.#handleDetailsInput(data, wide);
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
		this.#resetNavigation(this.#selectedIndexBeforeFilter);
	}

	#clearFilter(): void {
		this.#query = "";
		this.#queryBeforeEdit = "";
		this.#resetNavigation();
	}

	#syncFilterInput(): void {
		const query = this.#filterInput.getValue();
		if (query === this.#query) return;
		this.#query = query;
		this.#resetNavigation();
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
			this.#focus = "details";
		} else {
			this.#filterInput.handleInput(data);
			this.#syncFilterInput();
		}
		return true;
	}

	#isDirty(): boolean {
		return !toolNameSetsEqual(this.#initialInactiveToolNames, this.#inactiveToolNames);
	}

	#pendingCount(): number {
		return changedToolCount(this.#initialInactiveToolNames, this.#inactiveToolNames);
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
		const count = this.#pendingCount();
		try {
			const applied = this.#onApply(cloneNames(this.#inactiveToolNames));
			this.#items = applied.items;
			this.#currentActiveToolNames = cloneNames(applied.activeToolNames);
			this.#initialInactiveToolNames = cloneNames(applied.inactiveToolNames);
			this.#inactiveToolNames = cloneNames(applied.inactiveToolNames);
			this.#undoStack.length = 0;
			this.#resetNavigation(this.#selectedIndex);
			this.#flash = {
				kind: "success",
				text: `Applied ${count} Tool ${count === 1 ? "change" : "changes"} · No pending changes`,
			};
		} catch (error) {
			this.#flash = {
				kind: "error",
				text: error instanceof Error ? error.message : "Could not apply Tool changes",
			};
		}
		this.#requestRender();
	}

	#isPending(name: string): boolean {
		return this.#initialInactiveToolNames.has(name) !== this.#inactiveToolNames.has(name);
	}

	#recordChange(label: string, items: readonly ToolCatalogItem[], inactive: boolean): void {
		const previousInactiveByName = new Map<string, boolean>();
		for (const item of items) {
			const previous = this.#inactiveToolNames.has(item.name);
			if (previous === inactive) continue;
			previousInactiveByName.set(item.name, previous);
			if (inactive) this.#inactiveToolNames.add(item.name);
			else this.#inactiveToolNames.delete(item.name);
		}
		if (previousInactiveByName.size === 0) {
			this.#flash = {
				kind: "success",
				text: `Already ${inactive ? "inactive" : "active"} · ${this.#pendingText()}`,
			};
			return;
		}
		this.#undoStack.push({ label, previousInactiveByName });
		this.#flash = {
			kind: this.#pendingCount() > 0 ? "warning" : "success",
			text: `${inactive ? "Deactivate" : "Activate"} ${previousInactiveByName.size} · ${this.#pendingText()}`,
		};
	}

	#toggleCurrentItem(): void {
		const item = this.#currentItem();
		if (!item) return;
		this.#recordChange(item.displayName, [item], !this.#inactiveToolNames.has(item.name));
	}

	#setCurrentState(inactive: boolean): void {
		const item = this.#currentItem();
		if (item) {
			this.#recordChange(item.displayName, [item], inactive);
			return;
		}
		const group = this.#currentGroup();
		if (!group) return;
		const visibleItems = this.#filteredItems().filter((candidate) => candidate.groupKey === group.key);
		this.#recordChange(group.label, visibleItems, inactive);
	}

	#undoLatestChange(): void {
		const entry = this.#undoStack.pop();
		if (!entry) {
			this.#flash = { kind: "warning", text: "No Tool changes to undo" };
			return;
		}
		for (const [name, inactive] of entry.previousInactiveByName) {
			if (inactive) this.#inactiveToolNames.add(name);
			else this.#inactiveToolNames.delete(name);
		}
		this.#flash = {
			kind: this.#pendingCount() > 0 ? "warning" : "success",
			text: `Undo ${entry.label} · ${this.#pendingText()}`,
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
		if (data === "?" || this.#keybindings.matches(data, "tui.select.cancel")) this.#stateGuideOpen = false;
	}

	#activeTab(): SourceTab["id"] {
		return SOURCE_TABS[this.#sourceTabIndex]?.id ?? "all";
	}

	#cycleSource(delta: number): void {
		const selectable = orderedSourceTabs(this.#items).filter(({ tab, count }) => tab.id === "all" || count > 0);
		const current = Math.max(0, selectable.findIndex(({ index }) => index === this.#sourceTabIndex));
		const next = selectable[(current + delta + selectable.length) % selectable.length];
		if (!next) return;
		this.#sourceTabIndex = next.index;
		this.#resetNavigation();
		this.#flash = undefined;
	}

	#sourceItems(): ToolCatalogItem[] {
		const active = this.#activeTab();
		return active === "all" ? this.#items : this.#items.filter((item) => item.sourceKind === active);
	}

	#filteredItems(): ToolCatalogItem[] {
		return this.#sourceItems().filter(
			(item) => fuzzyMatch(item.displayName, this.#query) || fuzzyMatch(item.name, this.#query),
		);
	}

	#buildListRows(items: ToolCatalogItem[]): ListRow[] {
		const totals = new Map<string, number>();
		for (const item of this.#sourceItems()) totals.set(item.groupKey, (totals.get(item.groupKey) ?? 0) + 1);
		const grouped = new Map<string, ToolCatalogItem[]>();
		for (const item of items) {
			const existing = grouped.get(item.groupKey);
			if (existing) existing.push(item);
			else grouped.set(item.groupKey, [item]);
		}
		const rows: ListRow[] = [];
		const filtering = this.#query.trim().length > 0;
		for (const groupItems of grouped.values()) {
			const first = groupItems[0];
			if (!first) continue;
			const collapsed = !filtering && this.#collapsedGroupKeys.has(first.groupKey);
			rows.push({
				type: "group",
				key: first.groupKey,
				label: first.groupLabel,
				sourceKind: first.sourceKind,
				visibleCount: groupItems.length,
				totalCount: totals.get(first.groupKey) ?? groupItems.length,
				collapsed,
			});
			if (!collapsed) for (const item of groupItems) rows.push({ type: "item", item });
		}
		return rows;
	}

	#listRows(): ListRow[] {
		return this.#buildListRows(this.#filteredItems());
	}

	#rowKey(row: ListRow): string {
		return row.type === "group" ? `group:${row.key}` : `item:${row.item.name}`;
	}

	#selectedRow(): ListRow | undefined {
		const rows = this.#listRows();
		return rows[Math.max(0, Math.min(this.#selectedIndex, rows.length - 1))];
	}

	#currentItem(): ToolCatalogItem | undefined {
		const row = this.#selectedRow();
		return row?.type === "item" ? row.item : undefined;
	}

	#currentGroup(): GroupRow | undefined {
		const row = this.#selectedRow();
		return row?.type === "group" ? row : undefined;
	}

	#firstItemRowIndex(rows: ListRow[]): number {
		const index = rows.findIndex((row) => row.type === "item");
		return index >= 0 ? index : 0;
	}

	#resetNavigation(selectedIndex?: number): void {
		const rows = this.#listRows();
		this.#selectedIndex = selectedIndex === undefined
			? this.#firstItemRowIndex(rows)
			: Math.max(0, Math.min(selectedIndex, Math.max(0, rows.length - 1)));
		this.#detailsOffset = 0;
	}

	#moveSelection(delta: number): void {
		const rows = this.#listRows();
		if (rows.length === 0) return;
		this.#selectedIndex = (this.#selectedIndex + delta + rows.length) % rows.length;
		this.#detailsOffset = 0;
		this.#flash = undefined;
	}

	#setSelection(index: number): void {
		const rows = this.#listRows();
		if (rows.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(index, rows.length - 1));
		this.#detailsOffset = 0;
		this.#flash = undefined;
	}

	#moveFocus(delta: number, wide: boolean): void {
		const panes: PanelFocus[] = ["list", "details"];
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
			this.#flash = { kind: "warning", text: "Groups stay expanded while filtering" };
			return;
		}
		if (collapsed) this.#collapsedGroupKeys.add(group.key);
		else this.#collapsedGroupKeys.delete(group.key);
		const rows = this.#listRows();
		const index = rows.findIndex((row) => this.#rowKey(row) === `group:${group.key}`);
		this.#selectedIndex = index >= 0 ? index : this.#firstItemRowIndex(rows);
		this.#detailsOffset = 0;
		this.#flash = { kind: "success", text: `${collapsed ? "Collapsed" : "Expanded"} ${group.label}` };
	}

	#toggleCurrentGroup(): void {
		const group = this.#currentGroup();
		if (group) this.#setCurrentGroupCollapsed(!group.collapsed);
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
		} else if (data === " ") {
			if (this.#currentItem()) this.#toggleCurrentItem();
			else this.#flash = { kind: "warning", text: "Use a/d for group activation, Enter to fold" };
		} else if (data === "a") {
			this.#setCurrentState(false);
		} else if (data === "d") {
			this.#setCurrentState(true);
		} else if (data === "u") {
			this.#undoLatestChange();
		} else if (this.#keybindings.matches(data, "tui.select.confirm")) {
			if (this.#currentGroup()) this.#toggleCurrentGroup();
			else if (this.#currentItem()) {
				this.#focus = "details";
				this.#narrowView = "details";
			}
		} else if (!wide && data === "l" && this.#currentItem()) {
			this.#focus = "details";
			this.#narrowView = "details";
		}
	}

	#handleDetailsInput(data: string, wide: boolean): void {
		const page = Math.max(1, this.#lastDetailsViewportHeight - 1);
		const maxOffset = Math.max(0, this.#lastDetailsLineCount - this.#lastDetailsViewportHeight);
		if (this.#keybindings.matches(data, "tui.select.up") || data === "k") {
			this.#detailsOffset = Math.max(0, this.#detailsOffset - 1);
		} else if (this.#keybindings.matches(data, "tui.select.down") || data === "j") {
			this.#detailsOffset = Math.min(maxOffset, this.#detailsOffset + 1);
		} else if (this.#keybindings.matches(data, "tui.select.pageUp")) {
			this.#detailsOffset = Math.max(0, this.#detailsOffset - page);
		} else if (this.#keybindings.matches(data, "tui.select.pageDown")) {
			this.#detailsOffset = Math.min(maxOffset, this.#detailsOffset + page);
		} else if (matchesKey(data, Key.home)) {
			this.#detailsOffset = 0;
		} else if (matchesKey(data, Key.end)) {
			this.#detailsOffset = maxOffset;
		} else if (!wide && (data === "h" || matchesKey(data, Key.left))) {
			this.#focus = "list";
			this.#narrowView = "list";
		}
	}

	#topBorder(width: number, title: string): string[] {
		const innerWidth = Math.max(0, width - 2);
		const titleText = ` ${this.#theme.fg("accent", this.#theme.bold(title))} `;
		const fill = Math.max(0, innerWidth - visibleWidth(titleText));
		return [`${this.#theme.fg("borderMuted", "╭")}${titleText}${this.#theme.fg("borderMuted", "─".repeat(fill))}${this.#theme.fg("borderMuted", "╮")}`];
	}

	#border(left: string, middle: string, right: string, innerWidth: number): string {
		return this.#theme.fg("borderMuted", `${left}${middle.repeat(Math.max(0, innerWidth))}${right}`);
	}

	#pad(content: string, width: number): string {
		const clipped = truncateToWidth(content, Math.max(0, width), "…");
		return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
	}

	#selectedBackground(content: string): string {
		return content
			.split("\x1b[0m")
			.map((segment) => this.#theme.bg("selectedBg", segment))
			.join("\x1b[0m");
	}

	#paneContent(content: string, width: number, selected = false): string {
		const padded = this.#pad(` ${content}`, width);
		return selected ? this.#selectedBackground(padded) : padded;
	}

	#fullLine(content: string, innerWidth: number): string {
		return `${this.#theme.fg("borderMuted", "│")}${this.#paneContent(content, innerWidth)}${this.#theme.fg("borderMuted", "│")}`;
	}

	#joined(left: string, right: string, width: number): string {
		const available = Math.max(0, width - visibleWidth(right));
		const clippedLeft = truncateToWidth(left, available, "…");
		return `${clippedLeft}${" ".repeat(Math.max(1, width - visibleWidth(clippedLeft) - visibleWidth(right)))}${right}`;
	}

	#labelWidth(width: number): number {
		return width >= 34 ? Math.min(12, width - 1) : 0;
	}

	#labelPrefix(label: string, width: number): string {
		if (width <= 0) return "";
		const gap = Math.min(2, width);
		const textWidth = Math.max(0, width - gap);
		const clipped = truncateToWidth(label, textWidth, "");
		return `${this.#theme.fg("muted", `${clipped}${" ".repeat(Math.max(0, textWidth - visibleWidth(clipped)))}`)}${" ".repeat(gap)}`;
	}

	#labeledTextLines(label: string, value: string, width: number): string[] {
		const contentWidth = Math.max(1, width);
		const labelWidth = this.#labelWidth(contentWidth);
		if (labelWidth === 0) {
			return [
				...wrapTextWithAnsi(this.#theme.fg("muted", label), contentWidth),
				...wrapTextWithAnsi(value, Math.max(1, contentWidth - 2)).map((line) => `  ${line}`),
			];
		}
		const valueWidth = Math.max(1, contentWidth - labelWidth);
		const lines = wrapTextWithAnsi(value, valueWidth);
		return (lines.length > 0 ? lines : [""]).map(
			(line, index) => `${this.#labelPrefix(index === 0 ? label : "", labelWidth)}${line}`,
		);
	}

	#sectionSegment(title: string, width: number, focused: boolean): string {
		const label = ` ${focused ? this.#theme.fg("accent", this.#theme.bold(title)) : this.#theme.fg("muted", title)} `;
		return `${label}${this.#theme.fg("borderMuted", "─".repeat(Math.max(0, width - visibleWidth(label))))}`;
	}

	#sourceTabs(width: number): string {
		const parts = orderedSourceTabs(this.#items).map(({ tab, index, count }) => {
			const text = `${tab.label} ${count}`;
			return index === this.#sourceTabIndex
				? this.#theme.fg("accent", this.#theme.bold(`[${text}]`))
				: this.#theme.fg(count === 0 ? "dim" : "muted", text);
		});
		return truncateToWidth(parts.join("  "), width, "…");
	}

	#summary(width: number): string {
		const inactive = this.#items.filter((item) => this.#inactiveToolNames.has(item.name)).length;
		const active = this.#items.length - inactive;
		const entries = [
			this.#theme.fg("muted", `${this.#items.length}`),
			this.#theme.fg("accent", `● ${active}`),
			this.#theme.fg("dim", `○ ${inactive}`),
		];
		const pending = this.#pendingCount();
		if (pending > 0) entries.push(this.#theme.fg("warning", `△ ${pending}`));
		return truncateToWidth(entries.join(this.#theme.fg("muted", "  ·  ")), width, "…");
	}

	#searchValue(width: number): string {
		if (this.#filterEditing) {
			const rendered = this.#filterInput.render(Math.max(1, width) + 2)[0] ?? "> ";
			return truncateToWidth(rendered.replace(/^>\s?/, ""), width, "…");
		}
		return this.#query
			? this.#theme.fg("text", this.#query)
			: this.#theme.fg("dim", "/ to filter Tool Names");
	}

	#visibleListRows(height: number): ListRow[] {
		const rows = this.#listRows();
		if (height <= 0) return [];
		if (rows.length <= height) return rows;
		const selected = Math.max(0, Math.min(this.#selectedIndex, rows.length - 1));
		const centeredStart = (windowHeight: number): number =>
			Math.max(0, Math.min(selected - Math.floor(windowHeight / 2), rows.length - windowHeight));
		let start = centeredStart(height);
		if (start > 0 && rows[start]?.type === "item") {
			if (height === 1) return rows[selected] ? [rows[selected]] : [];
			const bodyHeight = height - 1;
			start = centeredStart(bodyHeight);
			if (start === 0 || rows[start]?.type === "group") return rows.slice(start, start + height);
			let groupIndex = start - 1;
			while (groupIndex >= 0 && rows[groupIndex]?.type !== "group") groupIndex -= 1;
			const group = rows[groupIndex];
			if (group?.type === "group") return [group, ...rows.slice(start, start + bodyHeight)];
		}
		return rows.slice(start, start + height);
	}

	#statusIcon(item: ToolCatalogItem): string {
		const currentActive = this.#currentActiveToolNames.has(item.name);
		const afterActive = !this.#inactiveToolNames.has(item.name);
		const plain = this.#isPending(item.name)
			? `${currentActive ? "●" : "○"}→${afterActive ? "●" : "○"}`
			: currentActive
				? "●"
				: "○";
		const color = this.#isPending(item.name) ? "warning" : currentActive ? "accent" : "dim";
		return this.#theme.fg(color, plain);
	}

	#renderListRows(width: number, height: number, focused: boolean): string[] {
		const filtered = this.#filteredItems();
		if (filtered.length === 0) {
			const message = this.#items.length === 0
				? "No registered Tools."
				: this.#query
					? `No Tool Names match “${this.#query}”.`
					: `No Tools from ${SOURCE_TABS[this.#sourceTabIndex]?.label ?? "this source"}.`;
			return [
				this.#paneContent(this.#theme.fg("muted", message), width),
				...Array.from({ length: Math.max(0, height - 1) }, () => " ".repeat(width)),
			];
		}
		const rows = this.#visibleListRows(height);
		const selected = this.#selectedRow();
		const selectedKey = selected ? this.#rowKey(selected) : undefined;
		const rendered = rows.map((row) => {
			const isSelected = this.#rowKey(row) === selectedKey;
			if (row.type === "group") {
				const icon = row.collapsed ? "▸" : "▾";
				const count = row.visibleCount === row.totalCount
					? `(${row.totalCount})`
					: `(${row.visibleCount}/${row.totalCount})`;
				const label = isSelected
					? this.#theme.fg("accent", this.#theme.bold(row.label))
					: this.#theme.fg("muted", row.label);
				return this.#paneContent(
					`${this.#theme.fg("muted", icon)} ${label} ${this.#theme.fg("muted", count)}`,
					width,
					isSelected && focused,
				);
			}
			const inactive = this.#inactiveToolNames.has(row.item.name);
			const label = isSelected
				? this.#theme.fg("accent", this.#theme.bold(row.item.displayName))
				: inactive
					? this.#theme.fg("dim", row.item.displayName)
					: this.#theme.fg("text", row.item.displayName);
			return this.#paneContent(`    ${this.#statusIcon(row.item)} ${label}`, width, isSelected && focused);
		});
		while (rendered.length < height) rendered.push(" ".repeat(width));
		return rendered.slice(0, height);
	}

	#stateText(item: ToolCatalogItem): string {
		const current = this.#currentActiveToolNames.has(item.name) ? "Active" : "Inactive";
		const after = this.#inactiveToolNames.has(item.name) ? "Inactive" : "Active";
		if (!this.#isPending(item.name)) return current;
		return `${current} → ${after} after Ctrl+S`;
	}

	#itemDetailLines(item: ToolCatalogItem, width: number): string[] {
		const provider = item.inventoryItem
			? `${item.inventoryItem.source.agentLabel} / ${item.inventoryItem.source.serverName} · ${item.inventoryItem.source.primitiveKind} ${item.inventoryItem.source.remoteName}`
			: item.sourceKind === "builtin"
				? "Pi"
				: "—";
		const guidelines = item.tool.promptGuidelines?.length
			? item.tool.promptGuidelines.map((line) => `• ${line}`).join("\n")
			: "None";
		const lines = [
			...this.#labeledTextLines("Name", this.#theme.fg("accent", this.#theme.bold(item.name)), width),
			...this.#labeledTextLines("State", this.#theme.fg(this.#isPending(item.name) ? "warning" : "text", this.#stateText(item)), width),
			...this.#labeledTextLines("Registrar", this.#theme.fg("text", item.registrar), width),
			...this.#labeledTextLines("Provider", this.#theme.fg("muted", provider), width),
			...this.#labeledTextLines("Scope", this.#theme.fg("muted", item.tool.sourceInfo.scope), width),
			...this.#labeledTextLines("Source", this.#theme.fg("muted", item.tool.sourceInfo.source), width),
			...this.#labeledTextLines("Path", this.#theme.fg("dim", displaySourcePath(item.tool.sourceInfo.path, homedir())), width),
			"",
			this.#theme.fg("accent", this.#theme.bold("Description")),
			...wrapTextWithAnsi(this.#theme.fg("text", item.tool.description || "(empty)"), width),
			"",
			this.#theme.fg("accent", this.#theme.bold("Parameters JSON Schema")),
			...safeJson(item.tool.parameters)
				.split("\n")
				.flatMap((line) => wrapTextWithAnsi(this.#theme.fg("mdCodeBlock", line), width)),
			"",
			this.#theme.fg("accent", this.#theme.bold("Prompt Guidelines")),
			...guidelines
				.split("\n")
				.flatMap((line) => wrapTextWithAnsi(this.#theme.fg("text", line), width)),
		];
		return lines;
	}

	#groupDetailLines(group: GroupRow, width: number): string[] {
		const items = this.#filteredItems().filter((item) => item.groupKey === group.key);
		const afterInactive = items.filter((item) => this.#inactiveToolNames.has(item.name)).length;
		const pending = items.filter((item) => this.#isPending(item.name)).length;
		return [
			...this.#labeledTextLines("Group", this.#theme.fg("accent", this.#theme.bold(group.label)), width),
			...this.#labeledTextLines("Tools", this.#theme.fg("text", group.visibleCount === group.totalCount ? String(group.totalCount) : `${group.visibleCount} visible / ${group.totalCount} total`), width),
			...this.#labeledTextLines("After", this.#theme.fg("muted", `● ${items.length - afterInactive} active · ○ ${afterInactive} inactive · △ ${pending} pending`), width),
			...this.#labeledTextLines("View", this.#theme.fg("muted", group.collapsed ? "Collapsed" : "Expanded"), width),
			"",
			...wrapTextWithAnsi(
				this.#theme.fg("dim", "a stages activation and d stages deactivation for the visible Tools in this group. Ctrl+S applies all Pending changes."),
				width,
			),
		];
	}

	#renderDetailsRows(width: number, height: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const group = this.#currentGroup();
		const item = this.#currentItem();
		const lines = group
			? this.#groupDetailLines(group, contentWidth)
			: item
				? this.#itemDetailLines(item, contentWidth)
				: [this.#theme.fg("muted", "Select a Tool to inspect its full definition.")];
		this.#lastDetailsLineCount = lines.length;
		this.#lastDetailsViewportHeight = height;
		this.#detailsOffset = Math.max(0, Math.min(this.#detailsOffset, Math.max(0, lines.length - height)));
		const rows = lines
			.slice(this.#detailsOffset, this.#detailsOffset + height)
			.map((line) => this.#paneContent(line, width));
		while (rows.length < height) rows.push(" ".repeat(width));
		return rows;
	}

	#helpWithFlash(help: string, width: number): string {
		if (!this.#flash) return this.#theme.fg("dim", help);
		const color = this.#flash.kind === "error" ? "error" : this.#flash.kind === "warning" ? "warning" : "success";
		const styledFlash = this.#theme.fg(color, this.#flash.text);
		if (this.#flash.kind === "error") return styledFlash;
		return this.#joined(this.#theme.fg("dim", help), styledFlash, width);
	}

	#preferredOverlayHeight(): number {
		return Math.max(12, Math.floor(this.#tui.terminal.rows * 0.78));
	}

	#renderWide(width: number): string[] {
		const innerWidth = width - 2;
		const headerWidth = Math.max(1, innerWidth - 2);
		const listWidth = Math.min(54, Math.max(38, Math.floor(innerWidth * 0.43)));
		const detailsWidth = innerWidth - listWidth - 1;
		const lines = this.#topBorder(width, "Tools");
		for (const line of this.#labeledTextLines("State", this.#summary(headerWidth), headerWidth)) lines.push(this.#fullLine(line, innerWidth));
		for (const line of this.#labeledTextLines("Sources", this.#sourceTabs(headerWidth), headerWidth)) lines.push(this.#fullLine(line, innerWidth));
		for (const line of this.#labeledTextLines("Filter", this.#searchValue(headerWidth), headerWidth)) lines.push(this.#fullLine(line, innerWidth));
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Tools", listWidth, this.#focus === "list")}${this.#theme.fg("borderMuted", "┬")}${this.#sectionSegment("Details", detailsWidth, this.#focus === "details")}${this.#theme.fg("borderMuted", "┤")}`,
		);
		const contentHeight = Math.max(5, Math.min(30, this.#preferredOverlayHeight() - lines.length - 2));
		const listRows = this.#renderListRows(listWidth, contentHeight, this.#focus === "list");
		const detailsRows = this.#renderDetailsRows(detailsWidth, contentHeight);
		for (let index = 0; index < contentHeight; index++) {
			lines.push(`${this.#theme.fg("borderMuted", "│")}${listRows[index]}${this.#theme.fg("borderMuted", "│")}${detailsRows[index]}${this.#theme.fg("borderMuted", "│")}`);
		}
		lines.push(`${this.#theme.fg("borderMuted", "├")}${this.#theme.fg("borderMuted", "─".repeat(listWidth))}${this.#theme.fg("borderMuted", "┴")}${this.#theme.fg("borderMuted", "─".repeat(detailsWidth))}${this.#theme.fg("borderMuted", "┤")}`);
		const help = this.#filterEditing
			? "Type name  ←/→ cursor  ↑/↓ select  Ctrl+U clear  Ctrl+W word  Enter keep  Esc cancel"
			: this.#focus === "details"
				? "j/k/PgUp/PgDn scroll  h/l focus  [/] source  / filter  Ctrl+S apply  Esc close"
				: this.#currentGroup()
					? "j/k  h/l fold  Enter toggle  a activate  d deactivate  [/] source  / filter  Ctrl+S apply"
					: "j/k select  h/l focus  Space toggle  a active  d inactive  u undo  [/] source  / filter  Ctrl+S apply";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderNarrow(width: number): string[] {
		return this.#narrowView === "details" ? this.#renderNarrowDetails(width) : this.#renderNarrowList(width);
	}

	#renderNarrowList(width: number): string[] {
		const innerWidth = width - 2;
		const headerWidth = Math.max(1, innerWidth - 2);
		const lines = this.#topBorder(width, "Tools");
		for (const line of this.#labeledTextLines("State", this.#summary(headerWidth), headerWidth)) lines.push(this.#fullLine(line, innerWidth));
		for (const line of this.#labeledTextLines("Sources", this.#sourceTabs(headerWidth), headerWidth)) lines.push(this.#fullLine(line, innerWidth));
		for (const line of this.#labeledTextLines("Filter", this.#searchValue(headerWidth), headerWidth)) lines.push(this.#fullLine(line, innerWidth));
		lines.push(`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Tools", innerWidth, true)}${this.#theme.fg("borderMuted", "┤")}`);
		const contentHeight = Math.max(4, Math.min(18, this.#preferredOverlayHeight() - lines.length - 3));
		for (const row of this.#renderListRows(innerWidth, contentHeight, true)) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help = this.#filterEditing
			? "Type name  Enter keep  Esc cancel"
			: this.#currentGroup()
				? "j/k  h/l fold  Enter toggle  a/d group  [/] source  / filter"
				: "j/k  Enter details  Space toggle  a/d state  u undo  [/] source  / filter";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderNarrowDetails(width: number): string[] {
		const innerWidth = width - 2;
		const lines = this.#topBorder(width, "Tool details");
		lines.push(`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Full definition", innerWidth, true)}${this.#theme.fg("borderMuted", "┤")}`);
		const contentHeight = Math.max(6, Math.min(26, this.#preferredOverlayHeight() - lines.length - 3));
		for (const row of this.#renderDetailsRows(innerWidth, contentHeight)) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		lines.push(this.#fullLine(this.#theme.fg("dim", "j/k/Pg scroll  h or Esc back  Ctrl+S apply"), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderDiscardDialog(width: number): string[] {
		if (width < 4) return [truncateToWidth("Discard changes?", width, "")];
		const innerWidth = width - 2;
		const pending = this.#pendingCount();
		const lines = this.#topBorder(width, "Unsaved Tool changes");
		lines.push(this.#fullLine(this.#theme.fg("warning", `Discard ${pending} pending ${pending === 1 ? "change" : "changes"}?`), innerWidth));
		lines.push(this.#fullLine(this.#theme.fg("dim", "Y discard   N/Enter/Esc keep editing"), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderStateGuide(width: number): string[] {
		if (width < 4) return [truncateToWidth("Tool state", width, "")];
		const innerWidth = width - 2;
		const contentWidth = Math.max(1, innerWidth - 2);
		const lines = this.#topBorder(width, "Tool state guide");
		const entries = [
			["●", "Active now and after Ctrl+S"],
			["○", "Inactive now and after Ctrl+S"],
			["●→○", "Pending deactivation"],
			["○→●", "Pending activation"],
		];
		for (const [icon, text] of entries) {
			lines.push(this.#fullLine(this.#joined(this.#theme.fg("accent", icon), this.#theme.fg("muted", text), contentWidth), innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		for (const line of wrapTextWithAnsi(this.#theme.fg("muted", "Only inactive Tool Names are persisted in the current Session Branch. New registered Tools are active by default."), contentWidth)) {
			lines.push(this.#fullLine(line, innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		lines.push(this.#fullLine(this.#theme.fg("dim", "? or Esc close guide"), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}
}
