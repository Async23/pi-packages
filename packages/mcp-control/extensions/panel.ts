import {
	getLanguageFromPath,
	highlightCode,
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
import {
	AGENT_SOURCES,
	type AgentId,
	type AgentSummary,
	type McpControlSnapshot,
	type McpServerEntry,
} from "./model.ts";

const WIDE_LAYOUT_MIN_WIDTH = 92;

type PanelFocus = "list" | "preview";

export interface McpPanelCursor {
	tabId?: "all" | AgentId;
	entryId?: string;
}

export type McpPanelResult =
	| { action: "close"; cursor: McpPanelCursor }
	| { action: "refresh"; cursor: McpPanelCursor }
	| { action: "add"; agentId: AgentId; cursor: McpPanelCursor }
	| { action: "edit"; entryId: string; cursor: McpPanelCursor }
	| { action: "delete"; entryId: string; cursor: McpPanelCursor }
	| { action: "connect"; entryId: string; cursor: McpPanelCursor }
	| { action: "disconnect"; entryId: string; cursor: McpPanelCursor }
	| { action: "prompt"; entryId: string; cursor: McpPanelCursor };

interface GroupRow {
	type: "group";
	key: string;
	label: string;
	agentId: AgentId;
	count: number;
}

interface EntryRow {
	type: "entry";
	entry: McpServerEntry;
}

type ListRow = GroupRow | EntryRow;

function fuzzyMatch(value: string, query: string): boolean {
	const haystack = value.toLowerCase();
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	let index = 0;
	for (const character of haystack) {
		if (character === needle[index]) index += 1;
		if (index === needle.length) return true;
	}
	return false;
}

function statusIcon(entry: McpServerEntry): string {
	if (entry.runtimeState === "ready") return "●";
	if (entry.runtimeState === "connecting" || entry.runtimeState === "closing") return "◐";
	if (entry.runtimeState === "failed" || entry.runtimeState === "auth-required") return "!";
	if (entry.resolution === "disabled") return "○";
	if (entry.resolution === "shadowed" || entry.resolution === "contributes") return "·";
	return "○";
}

function statusLabel(entry: McpServerEntry): string {
	if (entry.runtimeState === "ready") return "Connected";
	if (entry.runtimeState === "connecting") return "Connecting";
	if (entry.runtimeState === "auth-required") return "Authentication required";
	if (entry.runtimeState === "failed") return "Connection failed";
	if (entry.runtimeState === "closing") return "Disconnecting";
	if (entry.resolution === "shadowed") return "Shadowed by higher-precedence source";
	if (entry.resolution === "contributes") return "Contributes fields to effective Codex server";
	if (entry.resolution === "disabled") return "Disabled in source config";
	if (entry.resolution === "unknown-precedence") return "Source kept independent; precedence not guessed";
	return "Disconnected";
}

export class McpControlPanel implements Component, Focusable {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #snapshot: McpControlSnapshot;
	readonly #onDone: (result: McpPanelResult) => void;
	readonly #tabs: Array<"all" | AgentId>;
	readonly #sourceTabs: Array<"all" | AgentId>;
	#tabIndex = 0;
	#selectedIndex = 0;
	#query = "";
	#filterEditing = false;
	#filterInput = new Input();
	#focus: PanelFocus = "list";
	#previewOffset = 0;
	#lastWidth = 0;
	#lastPreviewLineCount = 0;
	#lastPreviewViewportHeight = 1;
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
		snapshot: McpControlSnapshot;
		cursor?: McpPanelCursor;
		onDone: (result: McpPanelResult) => void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#snapshot = options.snapshot;
		this.#onDone = options.onDone;
		const nonempty = AGENT_SOURCES.filter((agent) => this.#count(agent.id) > 0).map((agent) => agent.id);
		const empty = AGENT_SOURCES.filter((agent) => this.#count(agent.id) === 0).map((agent) => agent.id);
		this.#tabs = ["all", ...nonempty];
		this.#sourceTabs = ["all", ...nonempty, ...empty];
		const requestedTab = options.cursor?.tabId;
		this.#tabIndex = Math.max(0, requestedTab ? this.#tabs.indexOf(requestedTab) : 0);
		this.#selectedIndex = options.cursor?.entryId
			? this.#selectionForEntry(options.cursor.entryId)
			: this.#firstEntryIndex(this.#rows());
	}

	invalidate(): void {
		this.#filterInput.invalidate();
	}

	render(width: number): string[] {
		this.#lastWidth = width;
		if (width < 4) return [truncateToWidth("MCP", width, "")];
		return width >= WIDE_LAYOUT_MIN_WIDTH ? this.#renderWide(width) : this.#renderNarrow(width);
	}

	handleInput(data: string): void {
		if (this.#filterEditing) {
			if (this.#keybindings.matches(data, "tui.select.cancel")) {
				this.#filterEditing = false;
				this.#filterInput.focused = false;
			} else if (this.#keybindings.matches(data, "tui.select.confirm")) {
				this.#filterEditing = false;
				this.#filterInput.focused = false;
			} else if (this.#keybindings.matches(data, "tui.select.up")) this.#moveSelection(-1);
			else if (this.#keybindings.matches(data, "tui.select.down")) this.#moveSelection(1);
			else {
				this.#filterInput.handleInput(data);
				this.#query = this.#filterInput.getValue();
				this.#selectedIndex = this.#firstEntryIndex(this.#rows());
			}
			this.#tui.requestRender();
			return;
		}

		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#finish({ action: "close", cursor: this.#cursor() });
			return;
		}
		if (data === "/") {
			this.#filterEditing = true;
			this.#filterInput = new Input();
			this.#filterInput.setValue(this.#query);
			this.#filterInput.focused = this.#focused;
			this.#focus = "list";
		} else if (data === "[") this.#moveTab(-1);
		else if (data === "]") this.#moveTab(1);
		else if (matchesKey(data, Key.left) || data === "h") this.#moveFocus(-1);
		else if (matchesKey(data, Key.right) || data === "l") this.#moveFocus(1);
		else if (this.#lastWidth >= WIDE_LAYOUT_MIN_WIDTH && matchesKey(data, Key.tab)) this.#moveFocus(1);
		else if (this.#focus === "preview" && (this.#keybindings.matches(data, "tui.select.up") || data === "k")) {
			this.#scrollPreview(-1);
		} else if (this.#focus === "preview" && (this.#keybindings.matches(data, "tui.select.down") || data === "j")) {
			this.#scrollPreview(1);
		} else if (this.#focus === "preview" && this.#keybindings.matches(data, "tui.select.pageUp")) {
			this.#scrollPreview(-Math.max(1, this.#lastPreviewViewportHeight - 1));
		} else if (this.#focus === "preview" && this.#keybindings.matches(data, "tui.select.pageDown")) {
			this.#scrollPreview(Math.max(1, this.#lastPreviewViewportHeight - 1));
		} else if (this.#focus === "preview" && matchesKey(data, Key.home)) this.#previewOffset = 0;
		else if (this.#focus === "preview" && matchesKey(data, Key.end)) {
			this.#previewOffset = Math.max(0, this.#lastPreviewLineCount - this.#lastPreviewViewportHeight);
		} else if (this.#keybindings.matches(data, "tui.select.up") || data === "k") this.#moveSelection(-1);
		else if (this.#keybindings.matches(data, "tui.select.down") || data === "j") this.#moveSelection(1);
		else if (this.#keybindings.matches(data, "tui.select.pageUp")) this.#moveSelection(-8);
		else if (this.#keybindings.matches(data, "tui.select.pageDown")) this.#moveSelection(8);
		else if (matchesKey(data, Key.ctrl("u"))) this.#previewOffset = Math.max(0, this.#previewOffset - 8);
		else if (matchesKey(data, Key.ctrl("d"))) this.#previewOffset += 8;
		else if (data === "r") this.#finish({ action: "refresh", cursor: this.#cursor() });
		else if (data === "a") this.#add();
		else if (data === "e") this.#withEntry("edit");
		else if (data === "d") this.#withEntry("delete");
		else if (data === "p") this.#withEntry("prompt");
		else if (this.#keybindings.matches(data, "tui.select.confirm") || data === "c") this.#toggleConnection();
		this.#tui.requestRender();
	}

	#finish(result: McpPanelResult): void {
		this.#onDone(result);
	}

	#cursor(): McpPanelCursor {
		return { tabId: this.#activeTab(), entryId: this.#currentEntry()?.id };
	}

	#count(agentId: AgentId): number {
		return this.#snapshot.entries.filter((entry) => entry.agentId === agentId).length;
	}

	#activeTab(): "all" | AgentId {
		return this.#tabs[this.#tabIndex] ?? "all";
	}

	#filteredEntries(): McpServerEntry[] {
		const active = this.#activeTab();
		return this.#snapshot.entries.filter((entry) => {
			if (active !== "all" && entry.agentId !== active) return false;
			return fuzzyMatch(entry.serverName, this.#query);
		});
	}

	#rows(): ListRow[] {
		const entries = this.#filteredEntries();
		const rows: ListRow[] = [];
		if (this.#activeTab() === "all") {
			for (const agent of AGENT_SOURCES) {
				const agentEntries = entries.filter((entry) => entry.agentId === agent.id);
				if (agentEntries.length === 0) continue;
				rows.push({ type: "group", key: agent.id, label: agent.label, agentId: agent.id, count: agentEntries.length });
				rows.push(...agentEntries.map((entry): EntryRow => ({ type: "entry", entry })));
			}
			return rows;
		}

		for (const level of ["global", "project", "temporary"] as const) {
			const scoped = entries.filter((entry) => entry.level === level);
			if (scoped.length === 0) continue;
			rows.push({
				type: "group",
				key: level,
				label: level === "global" ? "Global" : level === "project" ? "Project" : "Temporary",
				agentId: this.#activeTab() as AgentId,
				count: scoped.length,
			});
			rows.push(...scoped.map((entry): EntryRow => ({ type: "entry", entry })));
		}
		return rows;
	}

	#selectionForEntry(entryId: string | undefined): number {
		if (!entryId) return this.#firstEntryIndex(this.#rows());
		const index = this.#rows().findIndex((row) => row.type === "entry" && row.entry.id === entryId);
		return index >= 0 ? index : this.#firstEntryIndex(this.#rows());
	}

	#firstEntryIndex(rows: readonly ListRow[]): number {
		const index = rows.findIndex((row) => row.type === "entry");
		return Math.max(0, index);
	}

	#currentRow(): ListRow | undefined {
		const rows = this.#rows();
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, Math.max(0, rows.length - 1)));
		return rows[this.#selectedIndex];
	}

	#currentEntry(): McpServerEntry | undefined {
		const row = this.#currentRow();
		return row?.type === "entry" ? row.entry : undefined;
	}

	#selectedAgent(): AgentId | undefined {
		const active = this.#activeTab();
		if (active !== "all") return active;
		const row = this.#currentRow();
		return row?.type === "entry" ? row.entry.agentId : row?.agentId;
	}

	#moveSelection(delta: number): void {
		const rows = this.#rows();
		const entryIndexes = rows.flatMap((row, index) => (row.type === "entry" ? [index] : []));
		if (entryIndexes.length === 0) return;
		const currentPosition = Math.max(0, entryIndexes.indexOf(this.#selectedIndex));
		const nextPosition = (currentPosition + (delta % entryIndexes.length) + entryIndexes.length) % entryIndexes.length;
		this.#selectedIndex = entryIndexes[nextPosition] ?? entryIndexes[0];
		this.#previewOffset = 0;
	}

	#moveTab(delta: number): void {
		this.#tabIndex = (this.#tabIndex + delta + this.#tabs.length) % this.#tabs.length;
		this.#selectedIndex = this.#firstEntryIndex(this.#rows());
		this.#previewOffset = 0;
	}

	#moveFocus(delta: number): void {
		const panes: PanelFocus[] = ["list", "preview"];
		const currentIndex = panes.indexOf(this.#focus);
		this.#focus = panes[(currentIndex + delta + panes.length) % panes.length] ?? "list";
	}

	#scrollPreview(delta: number): void {
		const maximum = Math.max(0, this.#lastPreviewLineCount - this.#lastPreviewViewportHeight);
		this.#previewOffset = Math.max(0, Math.min(this.#previewOffset + delta, maximum));
	}

	#add(): void {
		const agentId = this.#selectedAgent();
		if (!agentId) return;
		this.#finish({ action: "add", agentId, cursor: this.#cursor() });
	}

	#withEntry(action: "edit" | "delete" | "prompt"): void {
		const entry = this.#currentEntry();
		if (!entry) return;
		this.#finish({ action, entryId: entry.id, cursor: this.#cursor() });
	}

	#toggleConnection(): void {
		const entry = this.#currentEntry();
		if (!entry) return;
		this.#finish({
			action: entry.runtimeState === "ready" ? "disconnect" : "connect",
			entryId: entry.id,
			cursor: this.#cursor(),
		});
	}

	#pad(text: string, width: number): string {
		const clipped = truncateToWidth(text, Math.max(0, width), "…");
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

	#border(left: string, middle: string, right: string, innerWidth: number): string {
		return this.#theme.fg("borderMuted", `${left}${middle.repeat(Math.max(0, innerWidth))}${right}`);
	}

	#sectionSegment(label: string, width: number, focused: boolean): string {
		if (width <= 0) return "";
		const prefix = "─ ";
		const suffix = " ";
		const titleWidth = visibleWidth(prefix) + visibleWidth(label) + visibleWidth(suffix);
		const styledLabel = focused
			? this.#theme.fg("accent", this.#theme.bold(label))
			: this.#theme.fg("muted", label);
		return `${this.#theme.fg("borderMuted", prefix)}${styledLabel}${this.#theme.fg(
			"borderMuted",
			`${suffix}${"─".repeat(Math.max(0, width - titleWidth))}`,
		)}`;
	}

	#topBorder(width: number, title: string): string {
		const inner = width - 2;
		const styled = ` ${this.#theme.fg("accent", this.#theme.bold(title))} `;
		return `${this.#theme.fg("borderMuted", "╭─")}${styled}${this.#theme.fg(
			"borderMuted",
			`${"─".repeat(Math.max(0, inner - visibleWidth(styled) - 1))}╮`,
		)}`;
	}

	#fullLine(text: string, innerWidth: number): string {
		return `${this.#theme.fg("borderMuted", "│")}${this.#pad(` ${text}`, innerWidth)}${this.#theme.fg("borderMuted", "│")}`;
	}

	#tabLines(width: number): string[] {
		const items = this.#sourceTabs.map((id) => {
			const label = id === "all" ? "ALL" : AGENT_SOURCES.find((agent) => agent.id === id)?.shortLabel ?? id;
			const count = id === "all" ? this.#snapshot.entries.length : this.#count(id);
			const raw = `${label} ${count}`;
			return id === this.#activeTab()
				? this.#theme.fg("accent", this.#theme.bold(`[${raw}]`))
				: this.#theme.fg(count === 0 ? "dim" : "muted", raw);
		});
		const lines: string[] = [];
		let current = "";
		for (const item of items) {
			const candidate = current ? `${current}  ${item}` : item;
			if (visibleWidth(candidate) <= width) current = candidate;
			else {
				if (current) lines.push(current);
				current = item;
			}
		}
		if (current) lines.push(current);
		return lines;
	}

	#summary(): string {
		const connected = this.#snapshot.entries.filter((entry) => entry.runtimeState === "ready").length;
		const errors = this.#snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
		return `${this.#snapshot.entries.length} source entries  ${this.#theme.fg("success", `${connected} connected`)}  ${
			errors > 0 ? this.#theme.fg("warning", `${errors} config errors`) : this.#theme.fg("dim", "0 config errors")
		}`;
	}

	#searchText(): string {
		if (this.#filterEditing) return this.#filterInput.render(Math.max(8, this.#lastWidth - 16))[0] ?? "> ";
		return this.#query || `${this.#theme.fg("accent", "/")} ${this.#theme.fg("dim", "filter")}`;
	}

	#visibleRows(height: number): ListRow[] {
		const rows = this.#rows();
		if (rows.length <= height) return rows;
		const selectedRow = Math.max(0, Math.min(this.#selectedIndex, rows.length - 1));
		const start = Math.max(0, Math.min(selectedRow - Math.floor(height / 2), rows.length - height));
		const visible = rows.slice(start, start + height);
		if (start > 0 && visible[0]?.type === "entry") {
			const availableRows = height - 1;
			const stickyStart = Math.max(
				0,
				Math.min(selectedRow - Math.floor(availableRows / 2), rows.length - availableRows),
			);
			const stickyRows = rows.slice(stickyStart, stickyStart + availableRows);
			if (stickyRows[0]?.type === "entry") {
				let groupIndex = stickyStart - 1;
				while (groupIndex >= 0 && rows[groupIndex]?.type !== "group") groupIndex -= 1;
				const group = rows[groupIndex];
				if (group?.type === "group") return [group, ...stickyRows];
			}
			return rows.slice(stickyStart, stickyStart + height);
		}
		return visible;
	}

	#renderList(width: number, height: number, focused: boolean): string[] {
		const rows = this.#visibleRows(height);
		if (rows.length === 0) {
			const agent = this.#snapshot.agents.find((candidate) => candidate.id === this.#activeTab());
			const message = this.#query
				? `No MCP entries match '${this.#query}'.`
				: agent?.note ?? "No MCP server entries in this Agent source.";
			const output = wrapTextWithAnsi(this.#theme.fg("muted", message), Math.max(1, width - 2)).map((line) => this.#pad(` ${line}`, width));
			while (output.length < height) output.push(" ".repeat(width));
			return output.slice(0, height);
		}
		const selectedRow = this.#currentRow();
		const selectedKey = selectedRow
			? selectedRow.type === "entry"
				? `entry:${selectedRow.entry.id}`
				: `group:${selectedRow.key}`
			: undefined;
		const output = rows.map((row) => {
			const rowKey = row.type === "entry" ? `entry:${row.entry.id}` : `group:${row.key}`;
			const selected = rowKey === selectedKey;
			if (row.type === "group") {
				const label = `${row.label} (${row.count})`;
				return this.#paneContent(
					selected ? this.#theme.fg("accent", this.#theme.bold(label)) : this.#theme.fg("muted", label),
					width,
					selected && focused,
				);
			}
			const iconColor =
				row.entry.runtimeState === "ready"
					? "success"
					: row.entry.runtimeState === "failed" || row.entry.runtimeState === "auth-required"
						? "error"
						: "dim";
			const label = selected
				? this.#theme.fg("accent", this.#theme.bold(row.entry.serverName))
				: row.entry.resolution === "shadowed" || row.entry.resolution === "contributes"
					? this.#theme.fg("dim", row.entry.serverName)
					: this.#theme.fg("text", row.entry.serverName);
			const scope = this.#theme.fg("dim", row.entry.level === "global" ? "G" : row.entry.level === "project" ? "P" : "T");
			const line = `  ${this.#theme.fg(iconColor, statusIcon(row.entry))} ${label}  ${scope}`;
			return this.#paneContent(line, width, selected && focused);
		});
		while (output.length < height) output.push(" ".repeat(width));
		return output.slice(0, height);
	}

	#previewLines(width: number): string[] {
		const entry = this.#currentEntry();
		if (!entry) {
			const agentId = this.#selectedAgent() ?? (this.#activeTab() === "all" ? undefined : this.#activeTab());
			const agent = this.#snapshot.agents.find((candidate) => candidate.id === agentId);
			return wrapTextWithAnsi(this.#theme.fg("muted", agent?.note ?? "Select an MCP server entry."), width);
		}
		const count = entry.primitiveCounts;
		const lines = [
			this.#theme.fg("accent", this.#theme.bold(`${entry.agentLabel} / ${entry.serverName}`)),
			...wrapTextWithAnsi(`${this.#theme.fg("muted", "Status")}  ${statusLabel(entry)}`, width),
			...wrapTextWithAnsi(`${this.#theme.fg("muted", "Source")}  ${entry.sourceLabel}`, width),
			...wrapTextWithAnsi(`${this.#theme.fg("muted", "Pointer")} ${entry.entryPointer}`, width),
			`${this.#theme.fg("muted", "Transport")} ${entry.normalized.transport}`,
		];
		if (entry.normalized.command) lines.push(`${this.#theme.fg("muted", "Command")} ${entry.normalized.command} (+${entry.normalized.argumentCount} args)`);
		if (entry.normalized.url) lines.push(...wrapTextWithAnsi(`${this.#theme.fg("muted", "URL")}     ${entry.normalized.url}`, width));
		if (entry.normalized.environmentNames.length > 0) lines.push(`${this.#theme.fg("muted", "Env")}     ${entry.normalized.environmentNames.join(", ")}`);
		if (entry.normalized.headerNames.length > 0) lines.push(`${this.#theme.fg("muted", "Headers")} ${entry.normalized.headerNames.join(", ")}`);
		if (count) lines.push(`${this.#theme.fg("muted", "Primitives")} ${count.tools} tools · ${count.resources} resources · ${count.resourceTemplates} templates · ${count.prompts} prompts`);
		if (entry.runtimeError) lines.push(...wrapTextWithAnsi(this.#theme.fg("error", entry.runtimeError), width));
		lines.push("", this.#theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
		const sourceText = entry.sourceText || "<source text unavailable>";
		const language = entry.path.toLowerCase().endsWith(".jsonc") ? "jsonc" : getLanguageFromPath(entry.path);
		let sourceLines = sourceText.split(/\r?\n/);
		let highlighted = false;
		if (language) {
			try {
				sourceLines = highlightCode(sourceText, language);
				highlighted = sourceLines.some((line) => line.includes("\x1b["));
			} catch {
				// Pi may render this component before its global syntax theme is initialized.
			}
		}
		for (const line of sourceLines) {
			const styled = highlighted ? line : this.#theme.fg("dim", line);
			const wrapped = wrapTextWithAnsi(styled, width);
			lines.push(...(wrapped.length > 0 ? wrapped : [""]));
		}
		return lines;
	}

	#renderPreview(width: number, height: number): string[] {
		const lines = this.#previewLines(Math.max(1, width - 2));
		this.#lastPreviewLineCount = lines.length;
		this.#lastPreviewViewportHeight = height;
		this.#previewOffset = Math.max(0, Math.min(this.#previewOffset, Math.max(0, lines.length - height)));
		const output = lines.slice(this.#previewOffset, this.#previewOffset + height).map((line) => this.#pad(` ${line}`, width));
		while (output.length < height) output.push(" ".repeat(width));
		return output;
	}

	#headerLines(innerWidth: number): string[] {
		const lines = [this.#fullLine(this.#summary(), innerWidth)];
		for (const [index, tabs] of this.#tabLines(Math.max(1, innerWidth - 10)).entries()) {
			const label = index === 0 ? this.#theme.fg("muted", "Agents") : " ".repeat(6);
			lines.push(this.#fullLine(`${label}  ${tabs}`, innerWidth));
		}
		lines.push(this.#fullLine(`${this.#theme.fg("muted", "Filter")}  ${this.#searchText()}`, innerWidth));
		return lines;
	}

	#renderWide(width: number): string[] {
		const inner = width - 2;
		const listWidth = Math.min(42, Math.max(30, Math.floor(inner * 0.36)));
		const previewWidth = inner - listWidth - 1;
		const lines = [this.#topBorder(width, "MCP")];
		lines.push(...this.#headerLines(inner));
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("MCP servers", listWidth, this.#focus === "list")}${this.#theme.fg(
				"borderMuted",
				"┬",
			)}${this.#sectionSegment("Details", previewWidth, this.#focus === "preview")}${this.#theme.fg("borderMuted", "┤")}`,
		);
		const height = Math.max(6, Math.min(28, Math.floor(this.#tui.terminal.rows * 0.72) - lines.length - 3));
		const left = this.#renderList(listWidth, height, this.#focus === "list");
		const right = this.#renderPreview(previewWidth, height);
		for (let index = 0; index < height; index++) lines.push(`${this.#theme.fg("borderMuted", "│")}${left[index]}${this.#theme.fg("borderMuted", "│")}${right[index]}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(`${this.#theme.fg("borderMuted", "├")}${this.#theme.fg("borderMuted", "─".repeat(listWidth))}${this.#theme.fg("borderMuted", "┴")}${this.#theme.fg("borderMuted", "─".repeat(previewWidth))}${this.#theme.fg("borderMuted", "┤")}`);
		const help =
			this.#focus === "list"
				? "j/k select  h/l focus  [/] Agent  Enter/c connect  a add  e edit  d delete  p prompt  r refresh  / filter  Esc close"
				: "j/k/PgUp/PgDn scroll  h/l focus  [/] Agent  / filter  r refresh  Esc close";
		lines.push(this.#fullLine(this.#theme.fg("dim", help), inner));
		lines.push(this.#border("╰", "─", "╯", inner));
		return lines;
	}

	#renderNarrow(width: number): string[] {
		const inner = width - 2;
		const lines = [this.#topBorder(width, "MCP")];
		lines.push(...this.#headerLines(inner));
		lines.push(this.#border("├", "─", "┤", inner));
		const listHeight = Math.max(4, Math.min(12, Math.floor(this.#tui.terminal.rows * 0.36)));
		for (const row of this.#renderList(inner, listHeight, this.#focus === "list")) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", inner));
		const previewHeight = Math.max(4, Math.min(10, Math.floor(this.#tui.terminal.rows * 0.28)));
		for (const row of this.#renderPreview(inner, previewHeight)) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", inner));
		const help =
			this.#focus === "list"
				? "j/k select  h/l focus  [/] Agent  Enter connect  a/e/d  p prompt  r refresh  / filter  Esc"
				: "j/k/Pg scroll  h/l focus  [/] Agent  / filter  r refresh  Esc";
		lines.push(this.#fullLine(this.#theme.fg("dim", help), inner));
		lines.push(this.#border("╰", "─", "╯", inner));
		return lines;
	}
}
