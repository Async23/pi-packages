import {
	getAgentDir,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
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
type FlashKind = "success" | "error";

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
	scope: ContextScope;
	count: number;
}

interface ListItemRow {
	type: "item";
	item: ContextListItem;
	itemIndex: number;
}

type ListRow = ListGroupRow | ListItemRow;

interface PreviewCache {
	path: string;
	width: number;
	lines: string[];
}

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

function canonicalPath(filePath: string, cwd = process.cwd()): string {
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

function readConfig(configPath: string): { disabledPaths: Set<string>; error?: string } {
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

function writeConfig(configPath: string, disabledPaths: ReadonlySet<string>): void {
	const config: ContextControlConfig = {
		version: CONFIG_VERSION,
		disabledPaths: [...disabledPaths].sort(),
	};
	const temporaryPath = `${configPath}.${process.pid}.tmp`;
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, configPath);
}

class ContextControlPanel implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #items: ContextListItem[];
	readonly #disabledPaths: Set<string>;
	readonly #onToggle: (path: string) => string | undefined;
	readonly #onClose: () => void;

	#query = "";
	#selectedIndex = 0;
	#focus: PanelFocus = "list";
	#narrowView: NarrowView = "list";
	#previewOffset = 0;
	#lastWidth = 0;
	#lastPreviewLineCount = 0;
	#lastPreviewViewportHeight = 1;
	#previewCache: PreviewCache | undefined;
	#flash: { kind: FlashKind; text: string } | undefined;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		items: ContextListItem[];
		disabledPaths: Set<string>;
		onToggle: (path: string) => string | undefined;
		onClose: () => void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#items = options.items;
		this.#disabledPaths = options.disabledPaths;
		this.#onToggle = options.onToggle;
		this.#onClose = options.onClose;
	}

	invalidate(): void {
		this.#previewCache = undefined;
	}

	render(width: number): string[] {
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
		const wide = this.#lastWidth >= WIDE_LAYOUT_MIN_WIDTH;

		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			if (!wide && this.#narrowView === "preview") {
				this.#narrowView = "list";
				this.#focus = "list";
			} else {
				this.#onClose();
				return;
			}
			this.#requestRender();
			return;
		}

		if (wide && matchesKey(data, Key.tab)) {
			this.#focus = this.#focus === "list" ? "preview" : "list";
			this.#flash = undefined;
			this.#requestRender();
			return;
		}

		const previewActive = wide ? this.#focus === "preview" : this.#narrowView === "preview";
		if (previewActive) {
			this.#handlePreviewInput(data, wide);
		} else {
			this.#handleListInput(data, wide);
		}
		this.#requestRender();
	}

	#requestRender(): void {
		this.#tui.requestRender();
	}

	#filteredItems(): ContextListItem[] {
		const normalizedQuery = this.#query.trim().toLowerCase();
		if (!normalizedQuery) return this.#items;
		return this.#items.filter((item) =>
			`${item.label} ${item.path} ${item.scope}`.toLowerCase().includes(normalizedQuery),
		);
	}

	#currentItem(): ContextListItem | undefined {
		return this.#filteredItems()[this.#selectedIndex];
	}

	#moveSelection(delta: number): void {
		const items = this.#filteredItems();
		if (items.length === 0) return;
		this.#selectedIndex = (this.#selectedIndex + delta + items.length) % items.length;
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = undefined;
	}

	#setSelection(index: number): void {
		const items = this.#filteredItems();
		if (items.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(index, items.length - 1));
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = undefined;
	}

	#toggleCurrentItem(): void {
		const item = this.#currentItem();
		if (!item) return;
		const error = this.#onToggle(item.path);
		this.#flash = error ? { kind: "error", text: error } : { kind: "success", text: "Saved" };
	}

	#handleListInput(data: string, wide: boolean): void {
		const items = this.#filteredItems();
		if (this.#keybindings.matches(data, "tui.select.up")) {
			this.#moveSelection(-1);
		} else if (this.#keybindings.matches(data, "tui.select.down")) {
			this.#moveSelection(1);
		} else if (this.#keybindings.matches(data, "tui.select.pageUp")) {
			this.#setSelection(this.#selectedIndex - 8);
		} else if (this.#keybindings.matches(data, "tui.select.pageDown")) {
			this.#setSelection(this.#selectedIndex + 8);
		} else if (matchesKey(data, Key.home)) {
			this.#setSelection(0);
		} else if (matchesKey(data, Key.end)) {
			this.#setSelection(items.length - 1);
		} else if (data === " ") {
			this.#toggleCurrentItem();
		} else if (this.#keybindings.matches(data, "tui.select.confirm")) {
			if (this.#currentItem()) {
				this.#focus = "preview";
				if (!wide) this.#narrowView = "preview";
			}
			this.#flash = undefined;
		} else if (matchesKey(data, Key.backspace)) {
			this.#query = this.#query.slice(0, -1);
			this.#selectedIndex = 0;
			this.#previewOffset = 0;
			this.#previewCache = undefined;
			this.#flash = undefined;
		} else if (this.#isPrintable(data)) {
			this.#query += data;
			this.#selectedIndex = 0;
			this.#previewOffset = 0;
			this.#previewCache = undefined;
			this.#flash = undefined;
		}
	}

	#handlePreviewInput(data: string, wide: boolean): void {
		const pageSize = Math.max(1, this.#lastPreviewViewportHeight - 1);
		if (this.#keybindings.matches(data, "tui.select.up")) {
			this.#scrollPreview(-1);
		} else if (this.#keybindings.matches(data, "tui.select.down")) {
			this.#scrollPreview(1);
		} else if (this.#keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) {
			this.#scrollPreview(-pageSize);
		} else if (this.#keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) {
			this.#scrollPreview(pageSize);
		} else if (matchesKey(data, Key.home)) {
			this.#previewOffset = 0;
		} else if (matchesKey(data, Key.end)) {
			this.#previewOffset = Math.max(0, this.#lastPreviewLineCount - this.#lastPreviewViewportHeight);
		} else if (data === " ") {
			this.#toggleCurrentItem();
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

	#isPrintable(data: string): boolean {
		if (!data || data === " ") return false;
		return [...data].every((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint >= 32 && codePoint !== 127;
		});
	}

	#pad(text: string, width: number): string {
		const clipped = truncateToWidth(text, Math.max(0, width), "");
		return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
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
		const body = selected ? this.#theme.bg("selectedBg", padded) : padded;
		return `${this.#theme.fg("borderMuted", "│")}${body}${this.#theme.fg("borderMuted", "│")}`;
	}

	#paneContent(content: string, width: number, selected = false): string {
		const padded = this.#pad(` ${content}`, width);
		return selected ? this.#theme.bg("selectedBg", padded) : padded;
	}

	#maximumOverlayHeight(): number {
		return Math.max(1, Math.floor(this.#tui.terminal.rows * 0.9));
	}

	#preferredOverlayHeight(): number {
		return Math.max(1, Math.min(this.#maximumOverlayHeight(), Math.floor(this.#tui.terminal.rows * 0.78)));
	}

	#summary(): string {
		const activeCount = this.#items.filter((item) => !this.#disabledPaths.has(item.path)).length;
		const disabledCount = this.#items.length - activeCount;
		const parts = [
			this.#theme.fg("text", `${activeCount} included`),
			this.#theme.fg(disabledCount > 0 ? "warning" : "dim", `${disabledCount} excluded`),
		];
		return parts.join(this.#theme.fg("dim", "  ·  "));
	}

	#search(width: number): string {
		const placeholder = width >= 42 ? "type to filter paths" : "filter paths";
		const value = this.#query
			? `${this.#theme.fg("text", this.#query)}${this.#theme.fg("accent", "_")}`
			: `${this.#theme.fg("dim", placeholder)}${this.#theme.fg("accent", "_")}`;
		return `${this.#theme.fg("muted", "Search")}  ${value}`;
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

	#buildListRows(items: ContextListItem[]): ListRow[] {
		const rows: ListRow[] = [];
		let previousScope: ContextScope | undefined;
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			if (item.scope !== previousScope) {
				rows.push({
					type: "group",
					scope: item.scope,
					count: items.filter((candidate) => candidate.scope === item.scope).length,
				});
				previousScope = item.scope;
			}
			rows.push({ type: "item", item, itemIndex: index });
		}
		return rows;
	}

	#visibleListRows(height: number): ListRow[] {
		const items = this.#filteredItems();
		const rows = this.#buildListRows(items);
		if (rows.length <= height) return rows;

		const selectedRow = rows.findIndex((row) => row.type === "item" && row.itemIndex === this.#selectedIndex);
		const start = Math.max(0, Math.min(selectedRow - Math.floor(height / 2), rows.length - height));
		const visible = rows.slice(start, start + height);
		if (start > 0 && visible[0]?.type === "item") {
			const availableItemRows = height - 1;
			const stickyStart = Math.max(
				0,
				Math.min(
					selectedRow - Math.floor(availableItemRows / 2),
					rows.length - availableItemRows,
				),
			);
			const stickyRows = rows.slice(stickyStart, stickyStart + availableItemRows);
			const firstRow = stickyRows[0];
			if (firstRow?.type === "item") {
				const count = items.filter((candidate) => candidate.scope === firstRow.item.scope).length;
				return [{ type: "group", scope: firstRow.item.scope, count }, ...stickyRows];
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
		const rendered = rows.map((row) => {
			if (row.type === "group") {
				return this.#paneContent(this.#theme.fg("muted", `${row.scope} (${row.count})`), width);
			}

			const selected = row.itemIndex === this.#selectedIndex;
			const disabled = this.#disabledPaths.has(row.item.path);
			const icon = disabled ? this.#theme.fg("dim", "○") : this.#theme.fg("accent", "●");
			const label = selected
				? this.#theme.fg("accent", this.#theme.bold(row.item.label))
				: disabled
					? this.#theme.fg("dim", row.item.label)
					: this.#theme.fg("text", row.item.label);
			const content = disabled
				? this.#joined(`${icon}  ${label}`, this.#theme.fg("dim", "Excluded"), Math.max(0, width - 2))
				: `${icon}  ${label}`;
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

	#previewMetadata(item: ContextListItem, width: number): string[] {
		const bytes = new TextEncoder().encode(item.content).length;
		const metadata = `${lineCount(item.content)} lines · ${formatBytes(bytes)} · ~${formatCount(estimateTokens(item.content))} tokens`;
		const label = truncateToWidth(item.label, Math.max(1, width - 2), "…");
		return [
			this.#paneContent(this.#theme.fg("accent", this.#theme.bold(label)), width),
			this.#paneContent(this.#theme.fg("muted", item.scope), width),
			this.#paneContent(this.#theme.fg("dim", metadata), width),
		];
	}

	#renderPreviewRows(width: number, height: number): string[] {
		const item = this.#currentItem();
		if (!item) {
			const message = this.#items.length === 0
				? "No Context content to preview."
				: "Edit the search to select a file.";
			return [
				this.#paneContent(this.#theme.fg("muted", message), width),
				...Array.from({ length: height - 1 }, () => " ".repeat(width)),
			];
		}

		const metadata = this.#previewMetadata(item, width);
		const spacerCount = height >= 9 ? 2 : height >= 7 ? 1 : 0;
		const previewHeight = Math.max(1, height - metadata.length - 1 - spacerCount);
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
			: ` · View ${this.#previewOffset + 1}–${Math.min(this.#previewOffset + previewHeight, previewLines.length)} of ${previewLines.length} wrapped rows`;
		const dividerWidth = Math.max(0, width - 2);
		const dividerPrefix = this.#theme.fg("borderMuted", "─ ");
		const dividerTitle = this.#theme.fg("accent", this.#theme.bold("Content"));
		const dividerPosition = this.#theme.fg("dim", position);
		const dividerLabel = truncateToWidth(
			`${dividerPrefix}${dividerTitle}${dividerPosition}${this.#theme.fg("borderMuted", " ")}`,
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

		const spacer = this.#paneContent("", width);
		const beforeDivider = spacerCount >= 1 ? [spacer] : [];
		const afterDivider = spacerCount >= 2 ? [spacer] : [];
		const rows = [...metadata, ...beforeDivider, separator, ...afterDivider, ...content];
		while (rows.length < height) rows.push(" ".repeat(width));
		return rows.slice(0, height);
	}

	#helpWithFlash(help: string, width: number): string {
		const styledHelp = this.#theme.fg("dim", help);
		if (!this.#flash) return styledHelp;
		const styledFlash = this.#theme.fg(this.#flash.kind === "error" ? "error" : "success", this.#flash.text);
		if (this.#flash.kind === "error") return styledFlash;
		return this.#joined(styledHelp, styledFlash, width);
	}

	#renderWide(width: number): string[] {
		const innerWidth = width - 2;
		const listWidth = Math.min(42, Math.max(32, Math.floor(innerWidth * 0.38)));
		const previewWidth = innerWidth - listWidth - 1;
		const lines = this.#topBorder(width, "Context files");
		const contentHeight = Math.max(4, Math.min(30, this.#preferredOverlayHeight() - lines.length - 6));
		lines.push(this.#fullLine(this.#summary(), innerWidth));
		lines.push(this.#fullLine(this.#search(width), innerWidth));
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Files", listWidth, this.#focus === "list")}${this.#theme.fg(
				"borderMuted",
				"┬",
			)}${this.#sectionSegment("Preview", previewWidth, this.#focus === "preview")}${this.#theme.fg("borderMuted", "┤")}`,
		);

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
		const help = "↑↓ select/scroll   Tab switch pane   Space toggle   PgUp/PgDn scroll   Esc close";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderNarrow(width: number): string[] {
		return this.#narrowView === "preview" ? this.#renderNarrowPreview(width) : this.#renderNarrowList(width);
	}

	#renderNarrowList(width: number): string[] {
		const innerWidth = width - 2;
		const lines = this.#topBorder(width, "Context files");
		const contentHeight = Math.max(3, Math.min(16, this.#preferredOverlayHeight() - lines.length - 9));
		lines.push(this.#fullLine(this.#summary(), innerWidth));
		lines.push(this.#fullLine(this.#search(width), innerWidth));
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Files", innerWidth, true)}${this.#theme.fg("borderMuted", "┤")}`,
		);
		const listRows = this.#renderListRows(innerWidth, contentHeight, true);
		for (const row of listRows) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const selected = this.#currentItem();
		if (selected) {
			const disabled = this.#disabledPaths.has(selected.path);
			lines.push(this.#fullLine(this.#theme.fg("text", selected.path), innerWidth));
			lines.push(
				this.#fullLine(
					this.#theme.fg(disabled ? "warning" : "muted", disabled ? "Excluded from next request" : "Included in next request"),
					innerWidth,
				),
			);
		} else {
			lines.push(this.#fullLine(this.#theme.fg("dim", "Edit search to select a file."), innerWidth));
			lines.push(this.#fullLine("", innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help = width >= 55 ? "↑↓ select   Enter preview   Space toggle   Esc close" : "↑↓ select   Enter preview   Space toggle";
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
		const help = width >= 55 ? "↑↓/PgUp/PgDn scroll   Space toggle   Enter/Esc back" : "↑↓ scroll   Space toggle   Esc back";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}
}

export default function contextControlExtension(pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const loadedConfig = readConfig(configPath);
	const disabledPaths = loadedConfig.disabledPaths;
	let configError = loadedConfig.error;
	let promptMismatchWarningShown = false;

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

			await ctx.ui.custom(
				(tui, theme, keybindings, done) =>
					new ContextControlPanel({
						tui,
						theme,
						keybindings,
						items,
						disabledPaths,
						onToggle: (path) => {
							const wasDisabled = disabledPaths.has(path);
							if (wasDisabled) disabledPaths.delete(path);
							else disabledPaths.add(path);

							try {
								writeConfig(configPath, disabledPaths);
								return undefined;
							} catch {
								if (wasDisabled) disabledPaths.add(path);
								else disabledPaths.delete(path);
								configError = `Could not write context control config: ${configPath}`;
								ctx.ui.notify(configError, "error");
								return "Could not save Context settings";
							}
						},
						onClose: () => done(undefined),
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
