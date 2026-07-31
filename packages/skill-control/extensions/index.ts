import {
	formatSkillsForPrompt,
	getAgentDir,
	type ExtensionAPI,
	type KeybindingsManager,
	type Skill,
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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize, sep } from "node:path";
import {
	ACCESS_STATE_ORDER,
	CONFIG_FILE_NAME,
	accessForState,
	canonicalPath,
	changedOverrideCount,
	cloneOverrides,
	defaultSkillAccess,
	overridesEqual,
	readPolicyConfig,
	replaceOverrides,
	resolveSkillAccess,
	resolveUserAccess,
	skillAccessState,
	type SkillAccess,
	type SkillAccessState,
	type SkillOverrides,
	writePolicyConfig,
} from "./policy.ts";

export {
	accessForState,
	canonicalPath,
	defaultSkillAccess,
	readPolicyConfig,
	resolveSkillAccess,
	skillAccessState,
} from "./policy.ts";

const WIDE_LAYOUT_MIN_WIDTH = 92;

export type SkillSourceKind =
	| "agents"
	| "pi"
	| "claude"
	| "codex"
	| "opencode"
	| "package"
	| "settings"
	| "path"
	| "cli"
	| "extension"
	| "other";

type PanelFocus = "list" | "preview";
type NarrowView = "list" | "preview";
type FlashKind = "success" | "warning" | "error";

interface SkillListItem {
	path: string;
	name: string;
	label: string;
	description: string;
	sourceKind: SkillSourceKind;
	sourceLabel: string;
	content: string;
	defaultAccess: SkillAccess;
}

interface ListGroupRow {
	type: "group";
	label: string;
	count: number;
}

interface ListItemRow {
	type: "item";
	item: SkillListItem;
	itemIndex: number;
}

type ListRow = ListGroupRow | ListItemRow;

interface PreviewCache {
	path: string;
	width: number;
	lines: string[];
}

const SOURCE_ORDER: SkillSourceKind[] = [
	"agents",
	"pi",
	"claude",
	"codex",
	"opencode",
	"package",
	"settings",
	"path",
	"cli",
	"extension",
	"other",
];

const ALL_PROVIDERS_TAB = "ALL";

interface ProviderTab {
	id: string;
	label: string;
	shortLabel: string;
	match: (item: SkillListItem) => boolean;
}

const PROVIDER_TABS: ProviderTab[] = [
	{ id: "all", label: ALL_PROVIDERS_TAB, shortLabel: "ALL", match: () => true },
	{
		id: "agents",
		label: "Agents",
		shortLabel: "Agents",
		match: (item) => item.sourceKind === "agents",
	},
	{
		id: "pi",
		label: "Pi",
		shortLabel: "Pi",
		match: (item) => item.sourceKind === "pi",
	},
	{
		id: "claude",
		label: "Claude",
		shortLabel: "Claude",
		match: (item) => item.sourceKind === "claude",
	},
	{
		id: "codex",
		label: "Codex",
		shortLabel: "Codex",
		match: (item) => item.sourceKind === "codex",
	},
	{
		id: "opencode",
		label: "OpenCode",
		shortLabel: "OpenCode",
		match: (item) => item.sourceKind === "opencode",
	},
	{
		id: "package",
		label: "Package",
		shortLabel: "Package",
		match: (item) => item.sourceKind === "package",
	},
	{
		id: "settings",
		label: "Settings",
		shortLabel: "Settings",
		match: (item) => item.sourceKind === "settings",
	},
	{
		id: "path",
		label: "Path",
		shortLabel: "Path",
		match: (item) => item.sourceKind === "path",
	},
	{
		id: "cli",
		label: "CLI",
		shortLabel: "CLI",
		match: (item) => item.sourceKind === "cli",
	},
	{
		id: "extension",
		label: "Extension",
		shortLabel: "Extension",
		match: (item) => item.sourceKind === "extension",
	},
	{
		id: "other",
		label: "Other",
		shortLabel: "Other",
		match: (item) => item.sourceKind === "other",
	},
];

export function displayPath(filePath: string): string {
	const home = homedir();
	if (filePath === home) return "~";
	if (filePath.startsWith(`${home}${sep}`)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

function underPath(filePath: string, root: string): boolean {
	const normalizedRoot = normalize(root);
	return filePath === normalizedRoot || filePath.startsWith(`${normalizedRoot}${sep}`);
}

function containsSegment(filePath: string, segments: string[]): boolean {
	const needle = `${sep}${segments.join(sep)}${sep}`;
	const suffix = `${sep}${segments.join(sep)}`;
	return filePath.includes(needle) || filePath.endsWith(suffix);
}

export function classifySkillSource(
	skill: Skill,
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	home = homedir(),
): { kind: SkillSourceKind; label: string } {
	const path = canonicalPath(skill.filePath, cwd);
	const source = skill.sourceInfo.source ?? "";
	const agentsUser = canonicalPath(join(home, ".agents", "skills"), cwd);
	const agentUser = canonicalPath(join(home, ".agent", "skills"), cwd);
	const piUser = canonicalPath(join(agentDir, "skills"), cwd);
	const claudeUser = canonicalPath(join(home, ".claude", "skills"), cwd);
	const codexUser = canonicalPath(join(home, ".codex", "skills"), cwd);
	const opencodeUser = canonicalPath(join(home, ".config", "opencode", "skills"), cwd);

	if (skill.sourceInfo.origin === "package" || source.startsWith("npm:")) {
		const packageName = source.startsWith("npm:") ? source.slice(4) : source;
		return { kind: "package", label: packageName ? `Package (${packageName})` : "Package" };
	}
	if (source === "cli") return { kind: "cli", label: "CLI (--skill)" };
	if (source.startsWith("extension:")) {
		const extensionName = basename(source.slice("extension:".length)).replace(/\.(ts|js)$/, "");
		return {
			kind: "extension",
			label: extensionName ? `Extension (${extensionName})` : "Extension",
		};
	}

	if (underPath(path, agentsUser) || underPath(path, agentUser)) {
		return { kind: "agents", label: "Agents (user)" };
	}
	if (underPath(path, piUser)) {
		return { kind: "pi", label: "Pi (user)" };
	}
	if (underPath(path, claudeUser)) {
		return { kind: "claude", label: "Claude (user)" };
	}
	if (underPath(path, codexUser)) {
		return { kind: "codex", label: "Codex (user)" };
	}
	if (underPath(path, opencodeUser)) {
		return { kind: "opencode", label: "OpenCode (user)" };
	}

	if (containsSegment(path, [".claude", "skills"])) return { kind: "claude", label: "Claude (project)" };
	if (containsSegment(path, [".codex", "skills"])) return { kind: "codex", label: "Codex (project)" };
	if (containsSegment(path, [".config", "opencode", "skills"]) || containsSegment(path, [".opencode", "skills"])) {
		return { kind: "opencode", label: "OpenCode (project)" };
	}
	if (containsSegment(path, [".agents", "skills"]) || containsSegment(path, [".agent", "skills"])) {
		return { kind: "agents", label: "Agents (project)" };
	}
	if (containsSegment(path, [".pi", "skills"])) return { kind: "pi", label: "Pi (project)" };

	if (source === "local") {
		if (skill.sourceInfo.scope === "temporary") {
			return { kind: "path", label: "Explicit path (temporary)" };
		}
		return {
			kind: "settings",
			label: skill.sourceInfo.scope === "project" ? "Settings (project)" : "Settings (user)",
		};
	}
	if (skill.sourceInfo.scope === "project") return { kind: "other", label: "Other (project)" };
	return { kind: "other", label: "Other" };
}

export function accessStateLabel(state: SkillAccessState): string {
	switch (state) {
		case "both":
			return "Model + User";
		case "model":
			return "Model only";
		case "user":
			return "User only";
		case "neither":
			return "Neither";
	}
}

function readSkillContent(filePath: string): string {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
}

export function replaceSkillsSection(
	systemPrompt: string,
	originalSection: string,
	effectiveSection: string,
): string {
	if (originalSection === effectiveSection) return systemPrompt;
	if (originalSection) {
		const sectionIndex = systemPrompt.lastIndexOf(originalSection);
		if (sectionIndex === -1) return systemPrompt;
		return `${systemPrompt.slice(0, sectionIndex)}${effectiveSection}${systemPrompt.slice(sectionIndex + originalSection.length)}`;
	}
	if (!effectiveSection) return systemPrompt;

	const cwdMarker = "\nCurrent working directory:";
	const cwdIndex = systemPrompt.lastIndexOf(cwdMarker);
	if (cwdIndex === -1) return `${systemPrompt}${effectiveSection}`;
	return `${systemPrompt.slice(0, cwdIndex)}${effectiveSection}${systemPrompt.slice(cwdIndex)}`;
}

export function applySkillAccessToPrompt(
	systemPrompt: string,
	skills: readonly Skill[],
	overrides: ReadonlyMap<string, SkillAccess>,
	cwd = process.cwd(),
): string {
	const originalSection = formatSkillsForPrompt([...skills]);
	const effectiveSkills = skills.flatMap((skill) => {
		const path = canonicalPath(skill.filePath, cwd);
		const resolved = resolveSkillAccess(path, defaultSkillAccess(skill), overrides);
		if (!resolved.access.model) return [];
		return [{ ...skill, disableModelInvocation: false }];
	});
	const effectiveSection = formatSkillsForPrompt(effectiveSkills);
	return replaceSkillsSection(systemPrompt, originalSection, effectiveSection);
}

export type SkillControlPanelResult =
	| { action: "apply"; overrides: SkillOverrides }
	| { action: "close" };

export class SkillControlPanel implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #items: SkillListItem[];
	readonly #providers: ProviderTab[];
	readonly #initialOverrides: SkillOverrides;
	readonly #overrides: SkillOverrides;
	readonly #onDone: (result: SkillControlPanelResult) => void;

	#query = "";
	#filterEditing = false;
	#queryBeforeEdit = "";
	#selectedIndexBeforeFilter = 0;
	#selectedIndex = 0;
	#providerIndex = 0;
	#focus: PanelFocus = "list";
	#narrowView: NarrowView = "list";
	#previewOffset = 0;
	#lastWidth = 0;
	#lastPreviewLineCount = 0;
	#lastPreviewViewportHeight = 1;
	#previewCache: PreviewCache | undefined;
	#flash: { kind: FlashKind; text: string } | undefined;
	#accessGuideOpen = false;
	#confirmDiscard = false;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		items: SkillListItem[];
		overrides: ReadonlyMap<string, SkillAccess>;
		onDone: (result: SkillControlPanelResult) => void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#items = options.items;
		this.#providers = PROVIDER_TABS.filter(
			(provider) => provider.id === "all" || options.items.some((item) => provider.match(item)),
		);
		this.#initialOverrides = cloneOverrides(options.overrides);
		this.#overrides = cloneOverrides(options.overrides);
		this.#onDone = options.onDone;
	}

	invalidate(): void {
		this.#previewCache = undefined;
	}

	render(width: number): string[] {
		if (this.#confirmDiscard) {
			this.#lastWidth = width;
			return this.#renderDiscardDialog(width);
		}
		if (this.#accessGuideOpen) {
			this.#lastWidth = width;
			return this.#renderAccessGuide(width);
		}
		const wasWide = this.#lastWidth >= WIDE_LAYOUT_MIN_WIDTH;
		const isWide = width >= WIDE_LAYOUT_MIN_WIDTH;
		if (this.#lastWidth > 0 && wasWide !== isWide) {
			if (isWide) this.#focus = this.#narrowView;
			else this.#narrowView = this.#focus;
		}
		this.#lastWidth = width;
		if (width < 4) return [truncateToWidth("Skills", width, "")];
		return isWide ? this.#renderWide(width) : this.#renderNarrow(width);
	}

	handleInput(data: string): void {
		if (this.#confirmDiscard) {
			this.#handleDiscardInput(data);
			this.#requestRender();
			return;
		}
		if (this.#accessGuideOpen) {
			this.#handleAccessGuideInput(data);
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
			this.#accessGuideOpen = true;
			this.#flash = undefined;
			this.#requestRender();
			return;
		}

		if (matchesKey(data, Key.left) || data === "h") {
			this.#moveProvider(-1);
			this.#requestRender();
			return;
		}
		if (matchesKey(data, Key.right) || data === "l") {
			this.#moveProvider(1);
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
		this.#focus = "list";
		this.#narrowView = "list";
		this.#flash = undefined;
	}

	#commitFilterEditing(): void {
		this.#filterEditing = false;
		this.#queryBeforeEdit = this.#query;
		this.#selectedIndexBeforeFilter = this.#selectedIndex;
		this.#flash = undefined;
	}

	#cancelFilterEditing(): void {
		this.#query = this.#queryBeforeEdit;
		this.#filterEditing = false;
		this.#resetFilterNavigation(this.#selectedIndexBeforeFilter);
	}

	#clearFilter(): void {
		this.#query = "";
		this.#queryBeforeEdit = "";
		this.#resetFilterNavigation(0);
	}

	#setFilterQuery(query: string): void {
		this.#query = query;
		this.#resetFilterNavigation(0);
	}

	#resetFilterNavigation(selectedIndex: number): void {
		const lastIndex = Math.max(0, this.#filteredItems().length - 1);
		this.#selectedIndex = Math.max(0, Math.min(selectedIndex, lastIndex));
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = undefined;
	}

	#handleFilterInput(data: string, wide: boolean): boolean {
		const items = this.#filteredItems();
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
		} else if (matchesKey(data, Key.home)) {
			this.#setSelection(0);
		} else if (matchesKey(data, Key.end)) {
			this.#setSelection(items.length - 1);
		} else if (wide && matchesKey(data, Key.tab)) {
			this.#commitFilterEditing();
			this.#focus = "preview";
		} else if (matchesKey(data, Key.backspace)) {
			this.#setFilterQuery(this.#query.slice(0, -1));
		} else if (this.#isPrintable(data)) {
			this.#setFilterQuery(this.#query + data);
		} else {
			return false;
		}
		return true;
	}

	#isDirty(): boolean {
		return !overridesEqual(this.#initialOverrides, this.#overrides);
	}

	#pendingCount(): number {
		return changedOverrideCount(this.#initialOverrides, this.#overrides);
	}

	#apply(): void {
		if (!this.#isDirty()) {
			this.#onDone({ action: "close" });
			return;
		}
		this.#onDone({
			action: "apply",
			overrides: cloneOverrides(this.#overrides),
		});
	}

	#resolutionFor(item: SkillListItem) {
		return resolveSkillAccess(item.path, item.defaultAccess, this.#overrides);
	}

	#stateFor(item: SkillListItem): SkillAccessState {
		return skillAccessState(this.#resolutionFor(item).access);
	}

	#cycleCurrentItem(): void {
		const item = this.#currentItem();
		if (!item) return;
		const currentState = this.#stateFor(item);
		const currentIndex = ACCESS_STATE_ORDER.indexOf(currentState);
		const nextState = ACCESS_STATE_ORDER[(currentIndex + 1) % ACCESS_STATE_ORDER.length] ?? "both";
		const nextAccess = accessForState(nextState);
		const usesDefault =
			nextAccess.model === item.defaultAccess.model && nextAccess.user === item.defaultAccess.user;
		if (usesDefault) {
			this.#overrides.delete(item.path);
		} else {
			this.#overrides.set(item.path, nextAccess);
		}
		const pending = this.#pendingCount();
		const target = `${accessStateLabel(nextState)}${usesDefault ? " (default)" : ""}`;
		const pendingText = pending > 0 ? `Pending ${pending}` : "No pending changes";
		this.#flash = {
			kind: pending > 0 ? "warning" : "success",
			text: `${accessStateLabel(currentState)} → ${target} · ${pendingText}`,
		};
	}

	#handleAccessGuideInput(data: string): void {
		if (data === "?" || this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#accessGuideOpen = false;
		}
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

	#renderAccessGuide(width: number): string[] {
		if (width < 4) return [truncateToWidth("Skill access", width, "")];
		const innerWidth = width - 2;
		const lines = this.#topBorder(width, "Skill access guide");
		for (const line of wrapTextWithAnsi(
			this.#theme.fg("muted", "Model visibility and direct /skill access are controlled independently."),
			Math.max(1, innerWidth - 2),
		)) {
			lines.push(this.#fullLine(line, innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		lines.push(
			this.#fullLine(
				this.#joined(
					"",
					this.#accessColumns(this.#theme.fg("muted", "Model"), this.#theme.fg("muted", "You (/skill)")),
					innerWidth - 2,
				),
				innerWidth,
			),
		);

		for (let index = 0; index < ACCESS_STATE_ORDER.length; index++) {
			const state = ACCESS_STATE_ORDER[index];
			if (!state) continue;
			const icon = this.#stateIcon(state);
			const label = this.#theme.fg("text", accessStateLabel(state));
			const access = accessForState(state);
			const permissions = this.#accessColumns(
				this.#theme.fg(access.model ? "accent" : "dim", access.model ? "✓" : "—"),
				this.#theme.fg(access.user ? "warning" : "dim", access.user ? "✓" : "—"),
			);
			lines.push(this.#fullLine(this.#joined(`${icon}  ${label}`, permissions, innerWidth - 2), innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help = width >= 66 ? "Space cycles these states in the Skills list   Esc close" : "Esc close";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderDiscardDialog(width: number): string[] {
		if (width < 4) return [truncateToWidth("Discard changes?", width, "")];
		const innerWidth = width - 2;
		const pending = this.#pendingCount();
		const lines = this.#topBorder(width, "Unsaved Skill changes");
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

	#activeProvider(): ProviderTab {
		return this.#providers[this.#providerIndex] ?? this.#providers[0] ?? PROVIDER_TABS[0];
	}

	#moveProvider(delta: number): void {
		this.#providerIndex = (this.#providerIndex + delta + this.#providers.length) % this.#providers.length;
		this.#selectedIndex = 0;
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = undefined;
	}

	#providerItems(): SkillListItem[] {
		const provider = this.#activeProvider();
		if (provider.id === "all") return this.#items;
		return this.#items.filter((item) => provider.match(item));
	}

	#providerCount(provider: ProviderTab): number {
		if (provider.id === "all") return this.#items.length;
		return this.#items.filter((item) => provider.match(item)).length;
	}

	#filteredItems(): SkillListItem[] {
		const providerItems = this.#providerItems();
		const normalizedQuery = this.#query.trim().toLowerCase();
		if (!normalizedQuery) return providerItems;
		return providerItems
			.map((item, index) => ({ item, index, score: skillSearchScore(item, normalizedQuery) }))
			.filter(
				(entry): entry is { item: SkillListItem; index: number; score: number } =>
					entry.score !== undefined,
			)
			.sort((left, right) => right.score - left.score || left.index - right.index)
			.map((entry) => entry.item);
	}

	#currentItem(): SkillListItem | undefined {
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

	#handleListInput(data: string, wide: boolean): void {
		const items = this.#filteredItems();
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
			this.#setSelection(items.length - 1);
		} else if (data === " ") {
			this.#cycleCurrentItem();
		} else if (!wide && this.#keybindings.matches(data, "tui.select.confirm")) {
			if (this.#currentItem()) {
				this.#focus = "preview";
				this.#narrowView = "preview";
			}
			this.#flash = undefined;
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

	#isPrintable(data: string): boolean {
		if (!data) return false;
		return [...data].every((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint >= 32 && codePoint !== 127;
		});
	}

	#pad(text: string, width: number): string {
		const clipped = truncateToWidth(text, Math.max(0, width), "");
		return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
	}

	#center(text: string, width: number): string {
		const clipped = truncateToWidth(text, Math.max(0, width), "");
		const remaining = Math.max(0, width - visibleWidth(clipped));
		const left = Math.floor(remaining / 2);
		return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
	}

	#accessColumns(model: string, user: string): string {
		return `${this.#center(model, 5)}  ${this.#center(user, 12)}`;
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

	#summaryEntries(): { text: string; width: number }[] {
		const scoped = this.#providerItems();
		let bothCount = 0;
		let modelCount = 0;
		let userCount = 0;
		let neitherCount = 0;
		for (const item of scoped) {
			const state = this.#stateFor(item);
			if (state === "both") bothCount += 1;
			else if (state === "model") modelCount += 1;
			else if (state === "user") userCount += 1;
			else neitherCount += 1;
		}
		const entries = [
			`${this.#theme.fg("accent", "●")} ${this.#theme.fg("text", `${bothCount} Model + User`)}`,
			`${this.#theme.fg("accent", "◐")} ${this.#theme.fg("muted", `${modelCount} Model only`)}`,
			`${this.#theme.fg("warning", "◑")} ${this.#theme.fg("muted", `${userCount} User only`)}`,
			`${this.#theme.fg(neitherCount > 0 ? "warning" : "dim", "○")} ${this.#theme.fg(
				neitherCount > 0 ? "warning" : "dim",
				`${neitherCount} Neither`,
			)}`,
		];
		return entries.map((text) => ({ text, width: visibleWidth(text) }));
	}

	#stateIcon(state: SkillAccessState): string {
		switch (state) {
			case "both":
				return this.#theme.fg("accent", "●");
			case "model":
				return this.#theme.fg("accent", "◐");
			case "user":
				return this.#theme.fg("warning", "◑");
			case "neither":
				return this.#theme.fg("dim", "○");
		}
	}

	#labelWidth(width: number): number {
		return width >= 30 ? Math.min(14, width - 1) : 0;
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
			const valueLines = wrapTextWithAnsi(value, valueWidth);
			return [
				...wrapTextWithAnsi(this.#theme.fg("muted", label), contentWidth),
				...valueLines.map((line) => `${" ".repeat(indent)}${line}`),
			];
		}

		const valueWidth = Math.max(1, contentWidth - labelWidth);
		const valueLines = wrapTextWithAnsi(value, valueWidth);
		return (valueLines.length > 0 ? valueLines : [""]).map(
			(line, index) => `${this.#labelPrefix(index === 0 ? label : "", labelWidth)}${line}`,
		);
	}

	#wrapEntries(entries: { text: string; width: number }[], width: number): string[] {
		const contentWidth = Math.max(1, width);
		const separator = "  ";
		const separatorWidth = visibleWidth(separator);
		const lines: string[] = [];
		let current = "";
		let currentWidth = 0;

		for (const entry of entries) {
			if (entry.width > contentWidth) {
				if (current) lines.push(current);
				const wrapped = wrapTextWithAnsi(entry.text, contentWidth);
				lines.push(...wrapped.slice(0, -1));
				current = wrapped.at(-1) ?? "";
				currentWidth = visibleWidth(current);
				continue;
			}
			if (!current) {
				current = entry.text;
				currentWidth = entry.width;
				continue;
			}
			if (currentWidth + separatorWidth + entry.width <= contentWidth) {
				current = `${current}${separator}${entry.text}`;
				currentWidth += separatorWidth + entry.width;
				continue;
			}
			lines.push(current);
			current = entry.text;
			currentWidth = entry.width;
		}
		if (current) lines.push(current);
		return lines.length > 0 ? lines : [""];
	}

	#labeledEntryLines(label: string, entries: { text: string; width: number }[], width: number): string[] {
		const contentWidth = Math.max(1, width);
		const labelWidth = this.#labelWidth(contentWidth);
		if (labelWidth === 0) {
			const indent = Math.min(2, Math.max(0, contentWidth - 1));
			const entryWidth = Math.max(1, contentWidth - indent);
			return [
				...wrapTextWithAnsi(this.#theme.fg("muted", label), contentWidth),
				...this.#wrapEntries(entries, entryWidth).map((line) => `${" ".repeat(indent)}${line}`),
			];
		}

		const entryLines = this.#wrapEntries(entries, Math.max(1, contentWidth - labelWidth));
		return entryLines.map(
			(line, index) => `${this.#labelPrefix(index === 0 ? label : "", labelWidth)}${line}`,
		);
	}

	#providerTabLines(width: number): string[] {
		const activeIndex = Math.max(0, this.#providerIndex);

		const style = (text: string, index: number, empty: boolean) => {
			if (index === activeIndex) return this.#theme.fg("accent", this.#theme.bold(`[${text}]`));
			if (empty) return this.#theme.fg("dim", text);
			return this.#theme.fg("muted", text);
		};

		const entries = this.#providers.map((provider, index) => {
			const count = this.#providerCount(provider);
			const text = style(`${provider.shortLabel} ${count}`, index, false);
			return { text, width: visibleWidth(text) };
		});
		return this.#labeledEntryLines("Sources", entries, width);
	}

	#searchValue(width: number): string {
		const slash = this.#theme.fg("accent", "/");
		if (this.#filterEditing) {
			return `${slash}${this.#theme.fg("text", this.#query)}${this.#theme.fg("accent", "_")}`;
		}
		if (this.#query) return `${slash}${this.#theme.fg("text", this.#query)}`;
		const placeholder = width >= 42 ? " to filter skills" : " filter";
		return `${slash}${this.#theme.fg("dim", placeholder)}`;
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

	#buildListRows(items: SkillListItem[]): ListRow[] {
		const rows: ListRow[] = [];
		const showGroups = this.#activeProvider().id === "all";
		let previousLabel: string | undefined;
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			if (showGroups && item.sourceLabel !== previousLabel) {
				rows.push({
					type: "group",
					label: item.sourceLabel,
					count: items.filter((candidate) => candidate.sourceLabel === item.sourceLabel).length,
				});
				previousLabel = item.sourceLabel;
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
				Math.min(selectedRow - Math.floor(availableItemRows / 2), rows.length - availableItemRows),
			);
			const stickyRows = rows.slice(stickyStart, stickyStart + availableItemRows);
			const firstRow = stickyRows[0];
			if (firstRow?.type === "item") {
				const count = items.filter((candidate) => candidate.sourceLabel === firstRow.item.sourceLabel).length;
				return [{ type: "group", label: firstRow.item.sourceLabel, count }, ...stickyRows];
			}
			return rows.slice(stickyStart, stickyStart + height);
		}
		return visible;
	}

	#renderListRows(width: number, height: number, focused: boolean): string[] {
		const items = this.#filteredItems();
		if (items.length === 0) {
			const provider = this.#activeProvider();
			const message =
				this.#items.length === 0
					? "No skills discovered."
					: this.#query.trim()
						? `No skills match “${this.#query}”.`
						: `No skills in ${provider.label}.`;
			return [
				this.#paneContent(this.#theme.fg("muted", message), width),
				...Array.from({ length: height - 1 }, () => " ".repeat(width)),
			];
		}

		const rows = this.#visibleListRows(height);
		const rendered = rows.map((row) => {
			if (row.type === "group") {
				return this.#paneContent(this.#theme.fg("muted", `${row.label} (${row.count})`), width);
			}

			const selected = row.itemIndex === this.#selectedIndex;
			const state = this.#stateFor(row.item);
			const customized = this.#resolutionFor(row.item).source === "override";
			const icon = this.#stateIcon(state);
			const label = selected
				? this.#theme.fg("accent", this.#theme.bold(row.item.name))
				: state === "neither"
					? this.#theme.fg("dim", row.item.name)
					: this.#theme.fg("text", row.item.name);
			const left = `${icon}  ${label}`;
			const contentWidth = Math.max(0, width - 2);
			const content = customized
				? this.#joined(left, this.#theme.fg("muted", "Non-default"), contentWidth)
				: truncateToWidth(left, contentWidth, "…");
			return this.#paneContent(content, width, selected && focused);
		});
		while (rendered.length < height) rendered.push(" ".repeat(width));
		return rendered.slice(0, height);
	}

	#previewLines(item: SkillListItem, width: number): string[] {
		const contentWidth = Math.max(1, width);
		if (this.#previewCache?.path === item.path && this.#previewCache.width === contentWidth) {
			return this.#previewCache.lines;
		}
		if (item.content.length === 0) {
			this.#previewCache = { path: item.path, width: contentWidth, lines: [] };
			return [];
		}

		const lines: string[] = [];
		let inFrontmatter = false;
		let inCodeFence = false;
		for (const [index, sourceLine] of item.content.replace(/\r\n/g, "\n").split("\n").entries()) {
			const expanded = sourceLine.replace(/\t/g, "    ");
			const startsFrontmatter = index === 0 && /^\uFEFF?---\s*$/.test(expanded);
			const endsFrontmatter = inFrontmatter && /^(?:---|\.\.\.)\s*$/.test(expanded);
			const isFence = /^\s*```/.test(expanded);
			let styled = expanded;
			if (startsFrontmatter || endsFrontmatter) {
				styled = this.#theme.fg("syntaxPunctuation", expanded);
				inFrontmatter = startsFrontmatter;
			} else if (inFrontmatter) styled = this.#styleYamlFrontmatterLine(expanded);
			else if (inCodeFence || isFence) styled = this.#theme.fg("mdCodeBlock", expanded);
			else if (/^#{1,6}\s/.test(expanded)) styled = this.#theme.fg("mdHeading", this.#theme.bold(expanded));
			else if (/^\s*>/.test(expanded)) styled = this.#theme.fg("mdQuote", expanded);
			else styled = this.#theme.fg("text", expanded);

			const wrapped = expanded.length === 0 ? [""] : wrapTextWithAnsi(styled, contentWidth);
			lines.push(...wrapped);
			if (isFence && !inFrontmatter && !startsFrontmatter && !endsFrontmatter) inCodeFence = !inCodeFence;
		}
		this.#previewCache = { path: item.path, width: contentWidth, lines };
		return lines;
	}

	#styleYamlFrontmatterLine(line: string): string {
		const comment = line.match(/^(\s*)(#.*)$/);
		if (comment) return `${comment[1]}${this.#theme.fg("syntaxComment", comment[2] ?? "")}`;

		const mapping = line.match(/^(\s*)(-\s+)?([A-Za-z0-9_.-]+)(\s*):(\s*)(.*)$/);
		if (mapping) {
			const [, indent = "", listMarker = "", key = "", beforeColon = "", afterColon = "", value = ""] = mapping;
			return `${indent}${
				listMarker ? this.#theme.fg("syntaxPunctuation", listMarker) : ""
			}${this.#theme.fg("syntaxVariable", key)}${beforeColon}${this.#theme.fg(
				"syntaxPunctuation",
				":",
			)}${afterColon}${this.#styleYamlScalar(value)}`;
		}

		const sequence = line.match(/^(\s*)(-\s+)(.*)$/);
		if (sequence) {
			return `${sequence[1]}${this.#theme.fg("syntaxPunctuation", sequence[2] ?? "")}${this.#styleYamlScalar(
				sequence[3] ?? "",
			)}`;
		}

		const scalar = line.match(/^(\s*)(.*)$/);
		return `${scalar?.[1] ?? ""}${this.#styleYamlScalar(scalar?.[2] ?? "")}`;
	}

	#styleYamlScalar(value: string): string {
		if (value.length === 0) return "";
		if (/^#/.test(value)) return this.#theme.fg("syntaxComment", value);
		if (/^(?:true|false|null|~)$/i.test(value)) return this.#theme.fg("syntaxKeyword", value);
		if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
			return this.#theme.fg("syntaxNumber", value);
		}
		if (/^[>|][+-]?\d?$/.test(value)) return this.#theme.fg("syntaxOperator", value);
		return this.#theme.fg("syntaxString", value);
	}

	#previewPath(item: SkillListItem, width: number): string {
		return this.#paneContent(this.#theme.fg("muted", item.label), width);
	}

	#renderPreviewRows(width: number, height: number): string[] {
		const item = this.#currentItem();
		if (!item) {
			const message = this.#items.length === 0 ? "No skill content to preview." : "Press / to change the filter.";
			return [
				this.#paneContent(this.#theme.fg("muted", message), width),
				...Array.from({ length: height - 1 }, () => " ".repeat(width)),
			];
		}

		const path = this.#previewPath(item, width);
		const previewHeight = Math.max(1, height - 1);
		const contentWidth = Math.max(1, width - 2);
		const previewLines = this.#previewLines(item, contentWidth);
		this.#lastPreviewLineCount = previewLines.length;
		this.#lastPreviewViewportHeight = previewHeight;
		this.#previewOffset = Math.max(
			0,
			Math.min(this.#previewOffset, Math.max(0, previewLines.length - previewHeight)),
		);

		const content =
			previewLines.length === 0
				? [this.#paneContent(this.#theme.fg("warning", "This skill file is empty or unreadable."), width)]
				: previewLines
						.slice(this.#previewOffset, this.#previewOffset + previewHeight)
						.map((line) => this.#paneContent(line, width));

		const rows = [path, ...content];
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

	#renderWide(width: number): string[] {
		const innerWidth = width - 2;
		const headerWidth = Math.max(1, innerWidth - 2);
		const listWidth = Math.min(44, Math.max(32, Math.floor(innerWidth * 0.38)));
		const previewWidth = innerWidth - listWidth - 1;
		const lines = this.#topBorder(width, "Skills");
		for (const summaryLine of this.#labeledEntryLines("Access", this.#summaryEntries(), headerWidth)) {
			lines.push(this.#fullLine(summaryLine, innerWidth));
		}
		for (const tabLine of this.#providerTabLines(headerWidth)) {
			lines.push(this.#fullLine(tabLine, innerWidth));
		}
		for (const searchLine of this.#labeledTextLines("Filter", this.#searchValue(headerWidth), headerWidth)) {
			lines.push(this.#fullLine(searchLine, innerWidth));
		}
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Skills", listWidth, this.#focus === "list")}${this.#theme.fg(
				"borderMuted",
				"┬",
			)}${this.#sectionSegment("Preview", previewWidth, this.#focus === "preview")}${this.#theme.fg("borderMuted", "┤")}`,
		);

		const chromeAfterContent = 2; // footer help + bottom border
		const contentHeight = Math.max(
			4,
			Math.min(30, this.#preferredOverlayHeight() - lines.length - chromeAfterContent),
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
		const help = this.#filterEditing
			? "Type filter   ↑↓ select   Enter keep   Esc cancel"
			: this.#focus === "list"
				? "j/k select   / filter   Space cycle   ? guide   Tab Preview   h/l source   Ctrl+S apply   Esc close"
				: "j/k/PgUp/PgDn scroll   / filter   ? guide   Tab Skills   h/l source   Ctrl+S apply   Esc close";
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
		const lines = this.#topBorder(width, "Skills");
		for (const summaryLine of this.#labeledEntryLines("Access", this.#summaryEntries(), headerWidth)) {
			lines.push(this.#fullLine(summaryLine, innerWidth));
		}
		for (const tabLine of this.#providerTabLines(headerWidth)) {
			lines.push(this.#fullLine(tabLine, innerWidth));
		}
		for (const searchLine of this.#labeledTextLines("Filter", this.#searchValue(headerWidth), headerWidth)) {
			lines.push(this.#fullLine(searchLine, innerWidth));
		}
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Skills", innerWidth, true)}${this.#theme.fg("borderMuted", "┤")}`,
		);
		const chromeAfterContent = 5; // selected path + separators + help + bottom
		const contentHeight = Math.max(
			3,
			Math.min(16, this.#preferredOverlayHeight() - lines.length - chromeAfterContent),
		);
		const listRows = this.#renderListRows(innerWidth, contentHeight, true);
		for (const row of listRows) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const selected = this.#currentItem();
		if (selected) {
			lines.push(this.#fullLine(this.#theme.fg("text", selected.label), innerWidth));
		} else {
			lines.push(this.#fullLine(this.#theme.fg("dim", "Press / to change the filter."), innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help = this.#filterEditing
			? width >= 56
				? "Type filter  ↑↓ select  Enter keep  Esc cancel"
				: "Type filter  Enter keep  Esc cancel"
			: width >= 74
				? "h/l source  j/k select  Enter preview  / filter  Space cycle  ? guide"
				: width >= 56
					? "h/l source  j/k select  / filter  Space cycle"
					: "j/k select  / filter  Space cycle";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}

	#renderNarrowPreview(width: number): string[] {
		const innerWidth = width - 2;
		const lines = this.#topBorder(width, "Skill preview");
		const contentHeight = Math.max(5, Math.min(24, this.#preferredOverlayHeight() - lines.length - 4));
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("SKILL.md", innerWidth, true)}${this.#theme.fg("borderMuted", "┤")}`,
		);
		const previewRows = this.#renderPreviewRows(innerWidth, contentHeight);
		for (const row of previewRows) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help =
			width >= 76
				? "j/k/PgUp/PgDn scroll  / filter  ? guide  Ctrl+S apply  Enter/Esc back"
				: "j/k scroll  / filter  Esc back";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}
}

function toListItems(skills: readonly Skill[], cwd: string, agentDir: string): SkillListItem[] {
	const kindOrder = new Map(SOURCE_ORDER.map((kind, index) => [kind, index]));

	return [...skills]
		.map((skill) => {
			const path = canonicalPath(skill.filePath, cwd);
			const source = classifySkillSource(skill, cwd, agentDir);
			return {
				path,
				name: skill.name,
				label: displayPath(path),
				description: skill.description,
				sourceKind: source.kind,
				sourceLabel: source.label,
				content: readSkillContent(skill.filePath),
				defaultAccess: defaultSkillAccess(skill),
			};
		})
		.sort((left, right) => {
			const kindDelta = (kindOrder.get(left.sourceKind) ?? 99) - (kindOrder.get(right.sourceKind) ?? 99);
			if (kindDelta !== 0) return kindDelta;
			const labelDelta = left.sourceLabel.localeCompare(right.sourceLabel);
			if (labelDelta !== 0) return labelDelta;
			return left.name.localeCompare(right.name);
		});
}

export function parseSkillCommand(text: string): string | undefined {
	const match = text.match(/^\/skill:([^\s]+)(?:\s|$)/);
	return match?.[1];
}

function contiguousMatchScore(value: string, query: string, baseScore: number): number | undefined {
	const index = value.toLowerCase().indexOf(query);
	if (index < 0) return undefined;
	return baseScore - Math.min(index, 100);
}

function compactName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function editDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
			current[rightIndex] = Math.min(
				(current[rightIndex - 1] ?? 0) + 1,
				(previous[rightIndex] ?? 0) + 1,
				(previous[rightIndex - 1] ?? 0) + substitutionCost,
			);
		}
		previous = current;
	}
	return previous[right.length] ?? right.length;
}

function approximateNameScore(value: string, query: string): number | undefined {
	if (query.length < 4 || value.length === 0) return undefined;
	const maxDistance = query.length >= 9 ? 2 : 1;
	const minLength = Math.max(1, query.length - maxDistance);
	const maxLength = Math.min(value.length, query.length + maxDistance);
	let bestScore: number | undefined;

	for (let start = 0; start < value.length; start++) {
		for (let length = minLength; length <= maxLength && start + length <= value.length; length++) {
			const distance = editDistance(query, value.slice(start, start + length));
			if (distance > maxDistance) continue;
			const score =
				700 - distance * 80 - Math.min(start, 50) * 2 - Math.abs(length - query.length) * 20;
			bestScore = Math.max(bestScore ?? Number.NEGATIVE_INFINITY, score);
		}
	}
	return bestScore;
}

function fuzzyNameScore(value: string, query: string): number | undefined {
	const haystack = value.toLowerCase();
	if (haystack === query) return 1000;
	if (haystack.startsWith(query)) return 950 - Math.min(haystack.length - query.length, 50);
	const contiguousIndex = haystack.indexOf(query);
	if (contiguousIndex >= 0) return 900 - Math.min(contiguousIndex, 100);

	const compactHaystack = compactName(haystack);
	const compactQuery = compactName(query);
	if (compactQuery) {
		if (compactHaystack === compactQuery) return 880;
		if (compactHaystack.startsWith(compactQuery)) return 850 - Math.min(compactHaystack.length - compactQuery.length, 50);
		const compactIndex = compactHaystack.indexOf(compactQuery);
		if (compactIndex >= 0) return 820 - Math.min(compactIndex, 100);
		const approximateScore = approximateNameScore(compactHaystack, compactQuery);
		if (approximateScore !== undefined) return approximateScore;
	}

	let queryIndex = 0;
	let previousMatch = -1;
	let score = 420;
	for (let index = 0; index < haystack.length; index++) {
		if (haystack[index] !== query[queryIndex]) continue;
		score += 10;
		if (previousMatch >= 0) {
			const gap = index - previousMatch - 1;
			score += gap === 0 ? 20 : -Math.min(20, gap * 3);
		}
		if (index === 0 || /[-_./\s]/.test(haystack[index - 1] ?? "")) score += 15;
		previousMatch = index;
		queryIndex += 1;
		if (queryIndex === query.length) {
			return score - Math.min(80, haystack.length - query.length);
		}
	}
	return undefined;
}

function skillSearchScore(item: SkillListItem, query: string): number | undefined {
	const scores = [
		fuzzyNameScore(item.name, query),
		contiguousMatchScore(item.description, query, 300),
		contiguousMatchScore(item.sourceLabel, query, 260),
		contiguousMatchScore(item.label, query, 240),
		contiguousMatchScore(item.path, query, 220),
	].filter((score): score is number => score !== undefined);
	return scores.length > 0 ? Math.max(...scores) : undefined;
}

function fuzzyMatch(value: string, query: string): boolean {
	const haystack = value.toLowerCase();
	const needle = query.toLowerCase();
	let queryIndex = 0;
	for (const character of haystack) {
		if (character === needle[queryIndex]) queryIndex += 1;
		if (queryIndex === needle.length) return true;
	}
	return needle.length === 0;
}

export default function skillControlExtension(pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const overrides: SkillOverrides = new Map();
	let currentCwd = process.cwd();
	let configError: string | undefined;
	let autocompleteInstalled = false;
	let promptMismatchWarningShown = false;

	const loadPolicy = (cwd: string) => {
		const policy = readPolicyConfig(configPath);
		currentCwd = cwd;
		replaceOverrides(overrides, policy.overrides);
		configError = policy.error;
	};

	loadPolicy(process.cwd());

	pi.on("session_start", (_event, ctx) => {
		loadPolicy(ctx.cwd);
		if (configError) ctx.ui.notify(configError, "error");
		if (autocompleteInstalled || ctx.mode !== "tui") return;
		autocompleteInstalled = true;
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: current.triggerCharacters,
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const delegated = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (!beforeCursor.startsWith("/") || beforeCursor.includes(" ")) return delegated;

				const query = beforeCursor.slice(1);
				const skillCommands = pi.getCommands().filter((command) => command.source === "skill");
				const allowedCommands = skillCommands.filter((command) => {
					const path = canonicalPath(command.sourceInfo.path, currentCwd);
					return resolveUserAccess(path, overrides);
				});
				const blockedNames = new Set(
					skillCommands
						.filter((command) => !allowedCommands.includes(command))
						.map((command) => command.name),
				);
				const items = (delegated?.items ?? []).filter((item) => !blockedNames.has(item.value));
				const existing = new Set(items.map((item) => item.value));
				for (const command of allowedCommands) {
					if (existing.has(command.name) || !fuzzyMatch(command.name, query)) continue;
					items.push({ value: command.name, label: command.name, description: command.description });
				}
				return items.length > 0 ? { prefix: delegated?.prefix ?? beforeCursor, items } : null;
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});

	pi.registerCommand("skills", {
		description: "Control model and /skill access for discovered skills",
		handler: async (args, ctx) => {
			if (args.trim() !== "") {
				ctx.ui.notify("Usage: /skills", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/skills requires TUI mode", "error");
				return;
			}
			if (configError) {
				ctx.ui.notify(configError, "error");
				return;
			}

			const skills = ctx.getSystemPromptOptions().skills ?? [];
			const items = toListItems(skills, ctx.cwd, getAgentDir());

			const result = await ctx.ui.custom<SkillControlPanelResult>(
				(tui, theme, keybindings, done) =>
					new SkillControlPanel({
						tui,
						theme,
						keybindings,
						items,
						overrides,
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
			if (result.action !== "apply") return;

			const changed = !overridesEqual(overrides, result.overrides);
			const changeCount = changedOverrideCount(overrides, result.overrides);
			try {
				if (changed) writePolicyConfig(configPath, result.overrides);
				replaceOverrides(overrides, result.overrides);
				configError = undefined;
				ctx.ui.notify(`Applied ${changeCount} Skill ${changeCount === 1 ? "change" : "changes"}`, "info");
			} catch {
				configError = "Could not write Skill control configuration";
				ctx.ui.notify(configError, "error");
			}
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (overrides.size === 0) return;

		const skills = event.systemPromptOptions.skills ?? [];
		const filteredPrompt = applySkillAccessToPrompt(event.systemPrompt, skills, overrides, ctx.cwd);

		if (filteredPrompt === event.systemPrompt) {
			const modelPolicyDiffers = skills.some((skill) => {
				const path = canonicalPath(skill.filePath, ctx.cwd);
				const access = resolveSkillAccess(path, defaultSkillAccess(skill), overrides).access;
				return access.model !== !skill.disableModelInvocation;
			});
			if (modelPolicyDiffers && !promptMismatchWarningShown) {
				promptMismatchWarningShown = true;
				ctx.ui.notify("Skill control could not update Pi's available Skills section.", "warning");
			}
			return;
		}

		promptMismatchWarningShown = false;
		return { systemPrompt: filteredPrompt };
	});

	pi.on("input", (event, ctx) => {
		const skillName = parseSkillCommand(event.text);
		if (!skillName) return;
		const command = pi.getCommands().find((candidate) => candidate.source === "skill" && candidate.name === `skill:${skillName}`);
		if (!command) return;
		const path = canonicalPath(command.sourceInfo.path, ctx.cwd);
		if (resolveUserAccess(path, overrides)) return;
		ctx.ui.notify(`Skill '${skillName}' isn't available through /skill. Use /skills to change access.`, "warning");
		return { action: "handled" };
	});
}
