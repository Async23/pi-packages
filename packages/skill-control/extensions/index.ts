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
	type Focusable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize, resolve, sep } from "node:path";
import { BLOCKED_ICON, detectedUserOnlyIcon, FALLBACK_USER_ICON } from "./icons.ts";
import {
	CONFIG_FILE_NAME,
	canonicalPath,
	blockedPathsEqual,
	changedBlockedPathCount,
	cloneBlockedPaths,
	effectiveSkillAvailability,
	nativeSkillAvailability,
	readPolicyConfig,
	replaceBlockedPaths,
	skillAvailabilityState,
	type BlockedSkillPaths,
	type SkillAvailability,
	type SkillAvailabilityState,
	writePolicyConfig,
} from "./policy.ts";

export {
	canonicalPath,
	effectiveSkillAvailability,
	nativeSkillAvailability,
	readPolicyConfig,
	skillAvailabilityState,
} from "./policy.ts";

const WIDE_LAYOUT_MIN_WIDTH = 92;

export type SkillSourceKind =
	| "agents"
	| "pi"
	| "claude"
	| "codex"
	| "opencode"
	| "gemini"
	| "antigravity"
	| "cursor"
	| "trae"
	| "grok"
	| "kimi"
	| "zed"
	| "package"
	| "settings"
	| "path"
	| "cli"
	| "extension"
	| "other";

type SkillConfigurationLevel = "global" | "project" | "temporary";

type PanelFocus = "list" | "preview";
type NarrowView = "list" | "preview";
type FlashKind = "success" | "warning" | "error";

interface SkillListItem {
	path: string;
	scannedPath: string;
	name: string;
	label: string;
	scannedLabel: string;
	description: string;
	sourceKind: SkillSourceKind;
	sourceLabel: string;
	configurationLevel: SkillConfigurationLevel;
	content: string;
	nativeAvailability: SkillAvailability;
}

interface ListGroupRow {
	type: "group";
	key: string;
	label: string;
	count: number;
	collapsed: boolean;
}

interface ListItemRow {
	type: "item";
	item: SkillListItem;
}

type ListRow = ListGroupRow | ListItemRow;

interface PreviewCache {
	path: string;
	width: number;
	lines: string[];
}

interface PolicyUndoEntry {
	path: string;
	name: string;
	previousBlocked: boolean;
}

const SOURCE_ORDER: SkillSourceKind[] = [
	"agents",
	"pi",
	"claude",
	"codex",
	"opencode",
	"gemini",
	"antigravity",
	"cursor",
	"trae",
	"grok",
	"kimi",
	"zed",
	"package",
	"settings",
	"path",
	"cli",
	"extension",
	"other",
];

const CONFIGURATION_LEVEL_ORDER: readonly SkillConfigurationLevel[] = ["global", "project", "temporary"];

const CONFIGURATION_LEVEL_LABEL: Readonly<Record<SkillConfigurationLevel, string>> = {
	global: "Global",
	project: "Project",
	temporary: "Temporary",
};

function configurationLevelForScope(scope: Skill["sourceInfo"]["scope"]): SkillConfigurationLevel {
	if (scope === "project") return "project";
	if (scope === "temporary") return "temporary";
	return "global";
}

const ALL_PROVIDERS_TAB = "ALL";

interface ProviderTab {
	id: string;
	label: string;
	shortLabel: string;
	showWhenEmpty?: boolean;
	match: (item: SkillListItem) => boolean;
}

const PROVIDER_TABS: ProviderTab[] = [
	{ id: "all", label: ALL_PROVIDERS_TAB, shortLabel: "ALL", match: () => true },
	{
		id: "agents",
		label: ".agents",
		shortLabel: ".agents",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "agents",
	},
	{
		id: "pi",
		label: "Pi",
		shortLabel: "Pi",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "pi",
	},
	{
		id: "claude",
		label: "Claude",
		shortLabel: "Claude",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "claude",
	},
	{
		id: "codex",
		label: "Codex",
		shortLabel: "Codex",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "codex",
	},
	{
		id: "opencode",
		label: "OpenCode",
		shortLabel: "OpenCode",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "opencode",
	},
	{
		id: "gemini",
		label: "Gemini",
		shortLabel: "Gemini",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "gemini",
	},
	{
		id: "antigravity",
		label: "Antigravity",
		shortLabel: "Antigravity",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "antigravity",
	},
	{
		id: "cursor",
		label: "Cursor",
		shortLabel: "Cursor",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "cursor",
	},
	{
		id: "trae",
		label: "Trae",
		shortLabel: "Trae",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "trae",
	},
	{
		id: "grok",
		label: "Grok",
		shortLabel: "Grok",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "grok",
	},
	{
		id: "kimi",
		label: "Kimi Code",
		shortLabel: "Kimi Code",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "kimi",
	},
	{
		id: "zed",
		label: "Zed",
		shortLabel: "Zed",
		showWhenEmpty: true,
		match: (item) => item.sourceKind === "zed",
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

export function displayPath(filePath: string, home = homedir()): string {
	if (filePath === home) return "~";
	if (filePath.startsWith(`${home}${sep}`)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

function resolvedPath(filePath: string, cwd: string): string {
	return normalize(resolve(cwd, filePath));
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
	kimiCodeHome = process.env.KIMI_CODE_HOME || join(home, ".kimi-code"),
): { kind: SkillSourceKind; label: string } {
	// Preserve the lexical discovery path here. Policy keys use canonical paths,
	// but source labels must retain a symlink entry such as ~/.trae/skills.
	const path = resolvedPath(skill.filePath, cwd);
	const source = skill.sourceInfo.source ?? "";
	const agentsUser = resolvedPath(join(home, ".agents", "skills"), cwd);
	const antigravityLegacyUser = resolvedPath(join(home, ".agent", "skills"), cwd);
	const piUser = resolvedPath(join(agentDir, "skills"), cwd);
	const claudeUser = resolvedPath(join(home, ".claude", "skills"), cwd);
	const codexUser = resolvedPath(join(home, ".codex", "skills"), cwd);
	const opencodeUser = resolvedPath(join(home, ".config", "opencode", "skills"), cwd);
	const geminiUser = resolvedPath(join(home, ".gemini", "skills"), cwd);
	const antigravityUser = resolvedPath(join(home, ".gemini", "config", "skills"), cwd);
	const cursorUser = resolvedPath(join(home, ".cursor", "skills"), cwd);
	const traeUser = resolvedPath(join(home, ".trae", "skills"), cwd);
	const grokUser = resolvedPath(join(home, ".grok", "skills"), cwd);
	const kimiUser = resolvedPath(join(kimiCodeHome, "skills"), cwd);
	const userLabel = (name: string, root: string) => ({
		kind: name.toLowerCase() as SkillSourceKind,
		label: `${name} (${displayPath(root, home)})`,
	});

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

	if (underPath(path, agentsUser)) {
		return { kind: "agents", label: `.agents (${displayPath(agentsUser, home)})` };
	}
	if (underPath(path, piUser)) {
		return { kind: "pi", label: `Pi (${displayPath(piUser, home)})` };
	}
	if (underPath(path, claudeUser)) return userLabel("Claude", claudeUser);
	if (underPath(path, codexUser)) return userLabel("Codex", codexUser);
	if (underPath(path, opencodeUser)) return userLabel("OpenCode", opencodeUser);
	if (underPath(path, geminiUser)) return userLabel("Gemini", geminiUser);
	if (underPath(path, antigravityUser)) return userLabel("Antigravity", antigravityUser);
	if (underPath(path, antigravityLegacyUser)) return userLabel("Antigravity", antigravityLegacyUser);
	if (underPath(path, cursorUser)) return userLabel("Cursor", cursorUser);
	if (underPath(path, traeUser)) return userLabel("Trae", traeUser);
	if (underPath(path, grokUser)) return userLabel("Grok", grokUser);
	if (underPath(path, kimiUser)) {
		return { kind: "kimi", label: `Kimi Code (${displayPath(kimiUser, home)})` };
	}

	if (containsSegment(path, [".claude", "skills"])) return { kind: "claude", label: "Claude (project)" };
	if (containsSegment(path, [".codex", "skills"])) return { kind: "codex", label: "Codex (project)" };
	if (containsSegment(path, [".config", "opencode", "skills"]) || containsSegment(path, [".opencode", "skills"])) {
		return { kind: "opencode", label: "OpenCode (project)" };
	}
	if (containsSegment(path, [".gemini", "config", "skills"])) {
		return { kind: "antigravity", label: "Antigravity (project)" };
	}
	if (containsSegment(path, [".gemini", "skills"])) return { kind: "gemini", label: "Gemini (project)" };
	if (containsSegment(path, [".agent", "skills"])) {
		return { kind: "antigravity", label: "Antigravity (project legacy)" };
	}
	if (containsSegment(path, [".cursor", "skills"])) return { kind: "cursor", label: "Cursor (project)" };
	if (containsSegment(path, [".trae", "skills"])) return { kind: "trae", label: "Trae (project)" };
	if (containsSegment(path, [".grok", "skills"])) return { kind: "grok", label: "Grok (project)" };
	if (containsSegment(path, [".kimi-code", "skills"])) return { kind: "kimi", label: "Kimi Code (project)" };
	if (containsSegment(path, [".agents", "skills"])) return { kind: "agents", label: ".agents (project)" };
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

export function availabilityStateLabel(state: SkillAvailabilityState): string {
	switch (state) {
		case "model-and-command":
			return "Model + /skill";
		case "command-only":
			return "/skill only";
		case "blocked":
			return "Blocked";
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

export function applyBlockedSkillsToPrompt(
	systemPrompt: string,
	skills: readonly Skill[],
	blockedPaths: ReadonlySet<string>,
	cwd = process.cwd(),
): string {
	const originalSection = formatSkillsForPrompt([...skills]);
	const effectiveSkills = skills.filter((skill) => !blockedPaths.has(canonicalPath(skill.filePath, cwd)));
	const effectiveSection = formatSkillsForPrompt(effectiveSkills);
	return replaceSkillsSection(systemPrompt, originalSection, effectiveSection);
}

export type SkillControlPanelResult = { action: "close" };

export class SkillControlPanel implements Component, Focusable {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #items: SkillListItem[];
	readonly #providers: ProviderTab[];
	readonly #sourceTabs: ProviderTab[];
	readonly #initialBlockedPaths: BlockedSkillPaths;
	readonly #blockedPaths: BlockedSkillPaths;
	readonly #userOnlyIcon: string;
	readonly #onApply: (blockedPaths: BlockedSkillPaths) => void;
	readonly #onDone: (result: SkillControlPanelResult) => void;

	#query = "";
	#filterEditing = false;
	#filterInput = new Input();
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
	#routesGuideOpen = false;
	#confirmDiscard = false;
	#policyUndoStack: PolicyUndoEntry[] = [];
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
		items: SkillListItem[];
		blockedPaths: ReadonlySet<string>;
		userOnlyIcon?: string;
		onApply: (blockedPaths: BlockedSkillPaths) => void;
		onDone: (result: SkillControlPanelResult) => void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#items = options.items;
		this.#providers = PROVIDER_TABS.filter(
			(provider) => provider.id === "all" || options.items.some((item) => provider.match(item)),
		);
		const visibleSourceTabs = PROVIDER_TABS.filter(
			(provider) =>
				provider.id === "all" || provider.showWhenEmpty || options.items.some((item) => provider.match(item)),
		);
		const hasItems = (provider: ProviderTab) => options.items.some((item) => provider.match(item));
		this.#sourceTabs = [
			...visibleSourceTabs.filter((provider) => provider.id === "all"),
			...visibleSourceTabs.filter((provider) => provider.id !== "all" && hasItems(provider)),
			...visibleSourceTabs.filter((provider) => provider.id !== "all" && !hasItems(provider)),
		];
		this.#initialBlockedPaths = cloneBlockedPaths(options.blockedPaths);
		this.#blockedPaths = cloneBlockedPaths(options.blockedPaths);
		this.#userOnlyIcon = options.userOnlyIcon ?? FALLBACK_USER_ICON;
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
		if (this.#routesGuideOpen) {
			this.#lastWidth = width;
			return this.#renderRoutesGuide(width);
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
		if (this.#routesGuideOpen) {
			this.#handleRoutesGuideInput(data);
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
			this.#routesGuideOpen = true;
			this.#flash = undefined;
			this.#requestRender();
			return;
		}

		if (data === "[") {
			this.#moveProvider(-1);
			this.#requestRender();
			return;
		}
		if (data === "]") {
			this.#moveProvider(1);
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
		this.#selectedIndex =
			selectedIndex === undefined
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
		return !blockedPathsEqual(this.#initialBlockedPaths, this.#blockedPaths);
	}

	#pendingCount(): number {
		return changedBlockedPathCount(this.#initialBlockedPaths, this.#blockedPaths);
	}

	#apply(): void {
		if (!this.#isDirty()) {
			this.#flash = { kind: "success", text: "No pending changes" };
			this.#requestRender();
			return;
		}

		const changeCount = this.#pendingCount();
		try {
			this.#onApply(cloneBlockedPaths(this.#blockedPaths));
		} catch (error) {
			this.#flash = {
				kind: "error",
				text: error instanceof Error ? error.message : "Could not apply Skill changes",
			};
			this.#requestRender();
			return;
		}

		replaceBlockedPaths(this.#initialBlockedPaths, this.#blockedPaths);
		this.#policyUndoStack.length = 0;
		this.#flash = {
			kind: "success",
			text: `Applied ${changeCount} Skill ${changeCount === 1 ? "change" : "changes"} · No pending changes`,
		};
		this.#requestRender();
	}

	#isBlocked(item: SkillListItem): boolean {
		return this.#blockedPaths.has(item.path);
	}

	#stateFor(item: SkillListItem): SkillAvailabilityState {
		return skillAvailabilityState(
			effectiveSkillAvailability(item.path, item.nativeAvailability, this.#blockedPaths),
		);
	}

	#nativeStateFor(item: SkillListItem): SkillAvailabilityState {
		return skillAvailabilityState(item.nativeAvailability);
	}

	#isPolicyPending(item: SkillListItem): boolean {
		return this.#initialBlockedPaths.has(item.path) !== this.#blockedPaths.has(item.path);
	}

	#rowPolicyStatus(item: SkillListItem): "Blocked" | "Unsaved" | undefined {
		if (this.#isPolicyPending(item)) return "Unsaved";
		return this.#isBlocked(item) ? "Blocked" : undefined;
	}

	#policyStatus(item: SkillListItem): string {
		if (this.#isPolicyPending(item)) {
			return this.#isBlocked(item) ? "Pending block" : "Pending unblock";
		}
		return this.#isBlocked(item) ? "Blocked by policy" : "Unblocked";
	}

	#pendingText(): string {
		const pending = this.#pendingCount();
		return pending > 0 ? `Pending ${pending}` : "No pending changes";
	}

	#setCurrentItemBlocked(blocked: boolean): void {
		const item = this.#currentItem();
		if (!item) return;
		const currentlyBlocked = this.#isBlocked(item);
		if (currentlyBlocked === blocked) {
			this.#flash = {
				kind: "success",
				text: `Already ${blocked ? "Blocked" : "Unblocked"} · ${this.#pendingText()}`,
			};
			return;
		}

		this.#policyUndoStack.push({
			path: item.path,
			name: item.name,
			previousBlocked: currentlyBlocked,
		});
		if (blocked) this.#blockedPaths.add(item.path);
		else this.#blockedPaths.delete(item.path);

		const pending = this.#pendingCount();
		this.#flash = {
			kind: pending > 0 ? "warning" : "success",
			text: `${currentlyBlocked ? "Blocked" : "Unblocked"} → ${blocked ? "Blocked" : "Unblocked"} · ${this.#pendingText()}`,
		};
	}

	#toggleCurrentItem(): void {
		const item = this.#currentItem();
		if (!item) return;
		this.#setCurrentItemBlocked(!this.#isBlocked(item));
	}

	#unblockCurrentItem(): void {
		this.#setCurrentItemBlocked(false);
	}

	#undoLatestPolicyChange(): void {
		const entry = this.#policyUndoStack.pop();
		if (!entry) {
			this.#flash = { kind: "warning", text: "No policy changes to undo" };
			return;
		}
		const wasBlocked = this.#blockedPaths.has(entry.path);
		if (entry.previousBlocked) this.#blockedPaths.add(entry.path);
		else this.#blockedPaths.delete(entry.path);
		const pending = this.#pendingCount();
		this.#flash = {
			kind: pending > 0 ? "warning" : "success",
			text: `Undo ${entry.name}: ${wasBlocked ? "Blocked" : "Unblocked"} → ${entry.previousBlocked ? "Blocked" : "Unblocked"} · ${this.#pendingText()}`,
		};
	}

	#handleRoutesGuideInput(data: string): void {
		if (data === "?" || this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#routesGuideOpen = false;
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

	#renderRoutesGuide(width: number): string[] {
		if (width < 4) return [truncateToWidth("Skill routes", width, "")];
		const innerWidth = width - 2;
		const lines = this.#topBorder(width, "Skill routes and policy");
		for (const line of wrapTextWithAnsi(
			this.#theme.fg(
				"muted",
				"Pi defines native invocation routes. Skill Control applies a separate blocking policy.",
			),
			Math.max(1, innerWidth - 2),
		)) {
			lines.push(this.#fullLine(line, innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		lines.push(
			this.#fullLine(
				this.#joined(
					this.#theme.fg("muted", "Native routes"),
					this.#availabilityColumns(
						this.#theme.fg("muted", "Model sees"),
						this.#theme.fg("muted", "/skill"),
					),
					innerWidth - 2,
				),
				innerWidth,
			),
		);

		const nativeStates: { state: SkillAvailabilityState; availability: SkillAvailability }[] = [
			{
				state: "model-and-command",
				availability: { modelVisible: true, commandAvailable: true },
			},
			{
				state: "command-only",
				availability: { modelVisible: false, commandAvailable: true },
			},
		];
		for (const { state, availability } of nativeStates) {
			const icon = this.#nativeMarker(state);
			const label = this.#theme.fg("text", availabilityStateLabel(state));
			const routeLabel = icon ? `${icon}  ${label}` : label;
			const permissions = this.#availabilityColumns(
				this.#theme.fg(
					availability.modelVisible ? "accent" : "dim",
					availability.modelVisible ? "✓" : "—",
				),
				this.#theme.fg(
					availability.commandAvailable ? "warning" : "dim",
					availability.commandAvailable ? "✓" : "—",
				),
			);
			lines.push(this.#fullLine(this.#joined(routeLabel, permissions, innerWidth - 2), innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		lines.push(this.#fullLine(this.#theme.fg("muted", "Policy"), innerWidth));
		const blockedPermissions = this.#availabilityColumns(
			this.#theme.fg("dim", "—"),
			this.#theme.fg("dim", "—"),
		);
		lines.push(
			this.#fullLine(
				this.#joined(
					`${this.#theme.fg("warning", BLOCKED_ICON)}  ${this.#theme.fg("text", "Both routes unavailable")}`,
					blockedPermissions,
					innerWidth - 2,
				),
				innerWidth,
			),
		);
		for (const line of wrapTextWithAnsi(
			this.#theme.fg("muted", "Unblocked preserves the native routes shown above."),
			Math.max(1, innerWidth - 2),
		)) {
			lines.push(this.#fullLine(line, innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help =
			width >= 76
				? "Space toggle   r unblock   u undo   Esc close"
				: width >= 54
					? "Space toggle   r unblock   u undo   Esc close"
					: "Esc close";
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

	#moveFocus(delta: number, wide: boolean): void {
		const panes: PanelFocus[] = ["list", "preview"];
		const current = wide ? this.#focus : this.#narrowView;
		const currentIndex = panes.indexOf(current);
		const next = panes[(currentIndex + delta + panes.length) % panes.length] ?? "list";
		this.#focus = next;
		this.#narrowView = next;
		this.#flash = undefined;
	}

	#moveProvider(delta: number): void {
		this.#providerIndex = (this.#providerIndex + delta + this.#providers.length) % this.#providers.length;
		this.#selectedIndex = this.#firstItemRowIndex(this.#listRows());
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = undefined;
	}

	#providerItems(): SkillListItem[] {
		const provider = this.#activeProvider();
		if (provider.id === "all") return this.#items;
		return this.#orderByConfigurationLevel(this.#items.filter((item) => provider.match(item)));
	}

	#orderByConfigurationLevel(items: readonly SkillListItem[]): SkillListItem[] {
		return [...items].sort(
			(left, right) =>
				CONFIGURATION_LEVEL_ORDER.indexOf(left.configurationLevel) -
				CONFIGURATION_LEVEL_ORDER.indexOf(right.configurationLevel),
		);
	}

	#providerCount(provider: ProviderTab): number {
		if (provider.id === "all") return this.#items.length;
		return this.#items.filter((item) => provider.match(item)).length;
	}

	#filteredItems(): SkillListItem[] {
		const providerItems = this.#providerItems();
		const normalizedQuery = this.#query.trim().toLowerCase();
		if (!normalizedQuery) return providerItems;
		const matches = providerItems
			.map((item, index) => ({ item, index, score: skillSearchScore(item, normalizedQuery) }))
			.filter(
				(entry): entry is { item: SkillListItem; index: number; score: number } =>
					entry.score !== undefined,
			)
			.sort(
				(left, right) =>
					left.score - right.score || left.item.name.localeCompare(right.item.name) || left.index - right.index,
			)
			.map((entry) => entry.item);
		return this.#activeProvider().id === "all" ? matches : this.#orderByConfigurationLevel(matches);
	}

	#listRows(): ListRow[] {
		return this.#buildListRows(this.#filteredItems());
	}

	#firstItemRowIndex(rows: readonly ListRow[]): number {
		const index = rows.findIndex((row) => row.type === "item");
		return index >= 0 ? index : 0;
	}

	#rowKey(row: ListRow): string {
		return row.type === "group" ? `group:${row.key}` : `item:${row.item.path}`;
	}

	#selectedRow(rows = this.#listRows()): ListRow | undefined {
		return rows[this.#selectedIndex];
	}

	#currentItem(): SkillListItem | undefined {
		const row = this.#selectedRow();
		return row?.type === "item" ? row.item : undefined;
	}

	#currentGroup(): ListGroupRow | undefined {
		const row = this.#selectedRow();
		return row?.type === "group" ? row : undefined;
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

	#setCurrentGroupCollapsed(collapse: boolean): void {
		const group = this.#currentGroup();
		if (!group) return;
		if (this.#query.trim()) {
			this.#flash = {
				kind: collapse ? "warning" : "success",
				text: collapse ? "Groups stay expanded while filtering" : `Already expanded ${group.label}`,
			};
			return;
		}

		const currentlyCollapsed = this.#collapsedGroupKeys.has(group.key);
		if (currentlyCollapsed === collapse) {
			this.#flash = {
				kind: "success",
				text: `Already ${collapse ? "collapsed" : "expanded"} ${group.label}`,
			};
			return;
		}

		if (collapse) this.#collapsedGroupKeys.add(group.key);
		else this.#collapsedGroupKeys.delete(group.key);

		const rows = this.#listRows();
		const selectedKey = `group:${group.key}`;
		const nextIndex = rows.findIndex((row) => this.#rowKey(row) === selectedKey);
		this.#selectedIndex = nextIndex >= 0 ? nextIndex : this.#firstItemRowIndex(rows);
		this.#previewOffset = 0;
		this.#previewCache = undefined;
		this.#flash = {
			kind: "success",
			text: `${collapse ? "Collapsed" : "Expanded"} ${group.label} · ${group.count} ${group.count === 1 ? "Skill" : "Skills"}`,
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
			this.#unblockCurrentItem();
		} else if (data === "u") {
			this.#undoLatestPolicyChange();
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

	#center(text: string, width: number): string {
		const clipped = truncateToWidth(text, Math.max(0, width), "");
		const remaining = Math.max(0, width - visibleWidth(clipped));
		const left = Math.floor(remaining / 2);
		return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
	}

	#availabilityColumns(modelVisible: string, commandAvailable: string): string {
		return `${this.#center(modelVisible, 10)}  ${this.#center(commandAvailable, 8)}`;
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

	#selectedBackground(content: string): string {
		return content
			.split("\x1b[0m")
			.map((segment) => this.#theme.bg("selectedBg", segment))
			.join("\x1b[0m");
	}

	#maximumOverlayHeight(): number {
		return Math.max(1, Math.floor(this.#tui.terminal.rows * 0.9));
	}

	#preferredOverlayHeight(): number {
		return Math.max(1, Math.min(this.#maximumOverlayHeight(), Math.floor(this.#tui.terminal.rows * 0.78)));
	}

	#nativeMarker(state: SkillAvailabilityState): string {
		if (state === "command-only") return this.#theme.fg("warning", this.#userOnlyIcon);
		return "";
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

	#providerTabLines(width: number): string[] {
		const activeProvider = this.#activeProvider();

		const style = (text: string, active: boolean, empty: boolean) => {
			if (active) return this.#theme.fg("accent", this.#theme.bold(`[${text}]`));
			if (empty) return this.#theme.fg("dim", text);
			return this.#theme.fg("muted", text);
		};

		let emptyCount = 0;
		const entries: { text: string; width: number }[] = [];
		for (const provider of this.#sourceTabs) {
			const count = this.#providerCount(provider);
			if (provider.id !== "all" && count === 0) {
				emptyCount += 1;
				continue;
			}
			const text = style(`${provider.shortLabel} ${count}`, provider.id === activeProvider.id, count === 0);
			entries.push({ text, width: visibleWidth(text) });
		}
		if (emptyCount > 0) {
			const text = this.#theme.fg("dim", `${emptyCount} empty ${emptyCount === 1 ? "source" : "sources"}`);
			entries.push({ text, width: visibleWidth(text) });
		}
		return this.#wrapEntries(entries, width);
	}

	#filterValue(width: number): string {
		if (this.#filterEditing) {
			const rendered = this.#filterInput.render(Math.max(1, width) + 2)[0] ?? "> ";
			return (rendered.startsWith("> ") ? rendered.slice(2) : rendered).trimEnd();
		}
		if (this.#query) return `${this.#theme.fg("accent", "/")} ${this.#theme.fg("text", this.#query)}`;
		const provider = this.#activeProvider();
		const placeholder = provider.id === "all" ? " filter all skills" : ` filter within ${provider.label}`;
		return `${this.#theme.fg("accent", "/")}${this.#theme.fg("dim", placeholder)}`;
	}

	#filterHeaderLine(width: number): string {
		const value = this.#filterValue(width);
		if (this.#filterEditing) return truncateToWidth(value, Math.max(0, width), "");
		return this.#joined(value, this.#theme.fg("dim", "[/] source"), width);
	}

	#styledSectionSegment(label: string, width: number): string {
		if (width <= 0) return "";
		const prefix = "─ ";
		const suffix = " ";
		const labelWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
		const clippedLabel = truncateToWidth(label, labelWidth, "…");
		const titleWidth = visibleWidth(prefix) + visibleWidth(clippedLabel) + visibleWidth(suffix);
		const fill = Math.max(0, width - titleWidth);
		return `${this.#theme.fg("borderMuted", prefix)}${clippedLabel}${this.#theme.fg(
			"borderMuted",
			`${suffix}${"─".repeat(fill)}`,
		)}`;
	}

	#sectionSegment(label: string, width: number, focused: boolean): string {
		const styledLabel = focused
			? this.#theme.fg("accent", this.#theme.bold(label))
			: this.#theme.fg("muted", label);
		return this.#styledSectionSegment(styledLabel, width);
	}

	#listSectionSegment(width: number, focused: boolean): string {
		const items = this.#filteredItems();
		let modelCount = 0;
		let commandOnlyCount = 0;
		for (const item of items) {
			const state = this.#nativeStateFor(item);
			if (state === "model-and-command") modelCount += 1;
			else if (state === "command-only") commandOnlyCount += 1;
		}
		const blockedCount = items.filter((item) => this.#isBlocked(item)).length;
		const pendingCount = items.filter((item) => this.#isPolicyPending(item)).length;
		const separator = this.#theme.fg("borderMuted", " · ");
		const title = focused
			? this.#theme.fg("accent", this.#theme.bold(`Skills ${items.length}`))
			: this.#theme.fg("muted", `Skills ${items.length}`);
		const model = this.#theme.fg("muted", `model ${modelCount}`);
		const commandOnly = `${this.#theme.fg("warning", this.#userOnlyIcon)} ${this.#theme.fg(
			"muted",
			String(commandOnlyCount),
		)}`;
		const blockedColor = blockedCount > 0 ? "warning" : "dim";
		const blocked = this.#theme.fg(blockedColor, `${BLOCKED_ICON} ${blockedCount}`);
		const entries = [title, model, commandOnly, blocked];
		if (pendingCount > 0) entries.push(this.#theme.fg("warning", `△ ${pendingCount}`));
		return this.#styledSectionSegment(entries.join(separator), width);
	}

	#buildListRows(items: SkillListItem[]): ListRow[] {
		const grouped = new Map<string, { label: string; items: SkillListItem[] }>();
		for (const item of items) {
			const key = this.#groupKey(item);
			const existing = grouped.get(key);
			if (existing) existing.items.push(item);
			else grouped.set(key, { label: this.#groupLabel(item), items: [item] });
		}

		const rows: ListRow[] = [];
		const filtering = this.#query.trim().length > 0;
		for (const [key, group] of grouped) {
			const collapsed = !filtering && this.#collapsedGroupKeys.has(key);
			rows.push({ type: "group", key, label: group.label, count: group.items.length, collapsed });
			if (collapsed) continue;
			for (const item of group.items) rows.push({ type: "item", item });
		}
		return rows;
	}

	#groupLabel(item: SkillListItem): string {
		if (this.#activeProvider().id === "all") return item.sourceLabel;
		return CONFIGURATION_LEVEL_LABEL[item.configurationLevel];
	}

	#groupKey(item: SkillListItem): string {
		const provider = this.#activeProvider();
		if (provider.id === "all") return `all:${item.sourceKind}:${item.sourceLabel}`;
		return `${provider.id}:${item.configurationLevel}`;
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
		const selectedRow = this.#selectedRow();
		const selectedKey = selectedRow ? this.#rowKey(selectedRow) : undefined;
		const rendered = rows.map((row) => {
			if (row.type === "group") {
				const selected = this.#rowKey(row) === selectedKey;
				const icon = row.collapsed ? "▸" : "▾";
				const label = selected
					? this.#theme.fg("accent", this.#theme.bold(row.label))
					: this.#theme.fg("muted", row.label);
				return this.#paneContent(`${this.#theme.fg("muted", icon)} ${label} ${this.#theme.fg("muted", `(${row.count})`)}`, width, selected && focused);
			}

			const selected = this.#rowKey(row) === selectedKey;
			const nativeState = this.#nativeStateFor(row.item);
			const blocked = this.#isBlocked(row.item);
			const status = this.#rowPolicyStatus(row.item);
			const markers = [
				this.#nativeMarker(nativeState),
				status === "Blocked" ? this.#theme.fg("warning", BLOCKED_ICON) : "",
			].filter((marker) => marker.length > 0);
			const label = selected
				? this.#theme.fg("accent", this.#theme.bold(row.item.name))
				: blocked
					? this.#theme.fg("dim", row.item.name)
					: this.#theme.fg("text", row.item.name);
			const badge = status === "Unsaved" ? this.#theme.fg("warning", status) : "";
			const left = markers.length > 0 ? `    ${markers.join(" ")} ${label}` : `    ${label}`;
			const contentWidth = Math.max(0, width - 2);
			const content = badge ? this.#joined(left, badge, contentWidth) : left;
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

	#pathDetailLines(item: SkillListItem, width: number): string[] {
		if (item.scannedPath === item.path) {
			return this.#labeledTextLines("Path", this.#theme.fg("muted", item.label), width);
		}

		return [
			...this.#labeledTextLines("Scanned", this.#theme.fg("muted", item.scannedLabel), width),
			...this.#labeledTextLines(
				"Target",
				`${this.#theme.fg("muted", item.label)} ${this.#theme.fg("accent", "(symlink)")}`,
				width,
			),
		];
	}

	#previewPathRows(item: SkillListItem, width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		return this.#pathDetailLines(item, contentWidth).map((line) => this.#paneContent(line, width));
	}

	#groupAction(group: ListGroupRow): string {
		return group.collapsed
			? "l to expand this group · Space/Enter to toggle."
			: "h to collapse this group · Space/Enter to toggle.";
	}

	#groupPreviewLines(group: ListGroupRow, width: number): string[] {
		const state = group.collapsed ? "Collapsed" : "Expanded";
		return [
			...this.#labeledTextLines("Group", this.#theme.fg("text", group.label), width),
			...this.#labeledTextLines("Skills", this.#theme.fg("muted", String(group.count)), width),
			...this.#labeledTextLines("State", this.#theme.fg("accent", state), width),
			"",
			...wrapTextWithAnsi(this.#theme.fg("dim", this.#groupAction(group)), width),
		];
	}

	#groupCompactLines(group: ListGroupRow, width: number): string[] {
		const state = group.collapsed ? "Collapsed" : "Expanded";
		const count = `${group.count} ${group.count === 1 ? "skill" : "skills"} · ${state}`;
		return [
			...this.#labeledTextLines("Group", this.#theme.fg("text", group.label), width),
			...wrapTextWithAnsi(this.#theme.fg("muted", count), width),
			...wrapTextWithAnsi(this.#theme.fg("dim", this.#groupAction(group)), width),
		];
	}

	#renderGroupPreviewRows(group: ListGroupRow, width: number, height: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const lines = this.#groupPreviewLines(group, contentWidth);
		this.#lastPreviewLineCount = lines.length;
		this.#lastPreviewViewportHeight = height;
		this.#previewOffset = Math.max(0, Math.min(this.#previewOffset, Math.max(0, lines.length - height)));
		const rows = lines
			.slice(this.#previewOffset, this.#previewOffset + height)
			.map((line) => this.#paneContent(line, width));
		while (rows.length < height) rows.push(" ".repeat(width));
		return rows;
	}

	#availabilitySummaryText(item: SkillListItem): string {
		const native = availabilityStateLabel(this.#nativeStateFor(item));
		const effective = availabilityStateLabel(this.#stateFor(item));
		const policy = this.#policyStatus(item);
		const policyColor = this.#isPolicyPending(item) ? "warning" : this.#isBlocked(item) ? "muted" : "dim";
		return `${this.#theme.fg("muted", `Native ${native} · Effective ${effective} · `)}${this.#theme.fg(
			policyColor,
			policy,
		)}`;
	}

	#previewAvailabilitySummary(item: SkillListItem, width: number): string {
		return this.#paneContent(this.#availabilitySummaryText(item), width);
	}

	#renderPreviewRows(width: number, height: number): string[] {
		const group = this.#currentGroup();
		if (group) return this.#renderGroupPreviewRows(group, width, height);

		const item = this.#currentItem();
		if (!item) {
			const message = this.#items.length === 0 ? "No skill content to preview." : "Press / to change the filter.";
			return [
				this.#paneContent(this.#theme.fg("muted", message), width),
				...Array.from({ length: height - 1 }, () => " ".repeat(width)),
			];
		}

		const pathRows = this.#previewPathRows(item, width);
		const availabilitySummary = this.#previewAvailabilitySummary(item, width);
		const previewHeight = Math.max(1, height - pathRows.length - 1);
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

		const rows = [...pathRows, availabilitySummary, ...content];
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
				? "j/k  h collapse  l expand  Space/Enter toggle  Tab preview  [/] source  / filter  ? guide  Ctrl+S apply"
				: "j/k  h collapse  l expand  Space/Enter toggle  [/] source  / filter";
		}
		return width >= 112
			? "j/k select  h/l focus  [/] source  / filter  Space toggle  r unblock  u undo  ? guide  Ctrl+S apply"
			: "j/k select  h/l focus  [/] source  / filter  Space toggle  r/u";
	}

	#narrowListHelp(width: number): string {
		if (this.#currentGroup()) {
			return width >= 74
				? "j/k  h collapse  l expand  Space/Enter toggle  [/] source  / filter"
				: width >= 56
					? "j/k  h collapse  l expand  Space/Enter toggle"
					: "j/k  h fold  l open  Space/Enter";
		}
		return width >= 74
			? "j/k  Enter preview  h/l focus  [/] source  / filter  Space  r/u"
			: width >= 56
				? "j/k  Enter preview  h/l  [/] source  / filter"
				: "j/k  Enter preview  h/l focus";
	}

	#renderWide(width: number): string[] {
		const innerWidth = width - 2;
		const headerWidth = Math.max(1, innerWidth - 2);
		const listWidth = Math.min(44, Math.max(32, Math.floor(innerWidth * 0.38)));
		const previewWidth = innerWidth - listWidth - 1;
		const lines = this.#topBorder(width, "Skills");
		for (const tabLine of this.#providerTabLines(headerWidth)) {
			lines.push(this.#fullLine(tabLine, innerWidth));
		}
		lines.push(this.#fullLine(this.#filterHeaderLine(headerWidth), innerWidth));
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#listSectionSegment(listWidth, this.#focus === "list")}${this.#theme.fg(
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
			? "Type filter   ←/→ cursor   ↑/↓ select   Ctrl+U clear   Ctrl+W word   Enter keep   Esc cancel"
			: this.#focus === "list"
				? this.#wideListHelp(width)
				: width >= 100
					? "j/k/PgUp/PgDn scroll   h/l focus   [/] source   / filter   ? guide   Ctrl+S apply   Esc close"
					: "j/k/Pg scroll   h/l focus   [/] source   / filter   Ctrl+S apply   Esc close";
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
		for (const tabLine of this.#providerTabLines(headerWidth)) {
			lines.push(this.#fullLine(tabLine, innerWidth));
		}
		lines.push(this.#fullLine(this.#filterHeaderLine(headerWidth), innerWidth));
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#listSectionSegment(innerWidth, true)}${this.#theme.fg("borderMuted", "┤")}`,
		);
		const selectedItem = this.#currentItem();
		const selectedGroup = this.#currentGroup();
		const detailWidth = Math.max(1, innerWidth - 2);
		const selectedDetailLines = selectedItem
			? [...this.#pathDetailLines(selectedItem, detailWidth), this.#availabilitySummaryText(selectedItem)]
			: selectedGroup
				? this.#groupCompactLines(selectedGroup, detailWidth)
				: [this.#theme.fg("dim", "Press / to change the filter."), ""];
		const selectedDetailRows = selectedDetailLines.length;
		const chromeAfterContent = selectedDetailRows + 4; // details + separators + help + bottom
		const contentHeight = Math.max(
			3,
			Math.min(16, this.#preferredOverlayHeight() - lines.length - chromeAfterContent),
		);
		const listRows = this.#renderListRows(innerWidth, contentHeight, true);
		for (const row of listRows) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		for (const detailLine of selectedDetailLines) lines.push(this.#fullLine(detailLine, innerWidth));
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help = this.#filterEditing
			? width >= 76
				? "Type filter  ←/→ cursor  ↑/↓ select  Ctrl+U clear  Ctrl+W word  Enter keep  Esc cancel"
					: width >= 56
						? "Type filter  Ctrl+U clear  Ctrl+W word  Enter keep  Esc cancel"
						: "Type filter  Enter keep  Esc cancel"
				: this.#narrowListHelp(width);
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
				? "j/k/Pg scroll  h/l focus  [/] source  / filter  Ctrl+S apply  Esc back"
				: width >= 48
					? "j/k scroll  h/l focus  [/] source  Esc back"
					: "j/k scroll  h/l focus  Esc back";
		lines.push(this.#fullLine(this.#helpWithFlash(help, Math.max(0, innerWidth - 2)), innerWidth));
		lines.push(this.#border("╰", "─", "╯", innerWidth));
		return lines;
	}
}

function toListItems(skills: readonly Skill[], cwd: string, agentDir: string): SkillListItem[] {
	const kindOrder = new Map(SOURCE_ORDER.map((kind, index) => [kind, index]));

	return [...skills]
		.map((skill) => {
			const scannedPath = resolvedPath(skill.filePath, cwd);
			const path = canonicalPath(skill.filePath, cwd);
			const source = classifySkillSource(skill, cwd, agentDir);
			return {
				path,
				scannedPath,
				name: skill.name,
				label: displayPath(path),
				scannedLabel: displayPath(scannedPath),
				description: skill.description,
				sourceKind: source.kind,
				sourceLabel: source.label,
				configurationLevel: configurationLevelForScope(skill.sourceInfo.scope),
				content: readSkillContent(skill.filePath),
				nativeAvailability: nativeSkillAvailability(skill),
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

// Mirrors Codex CLI's case-insensitive subsequence matcher: lower scores are
// better, contiguous matches have no gap cost, and matches starting at the
// beginning receive a 100-point bonus.
function codexFuzzyMatchScore(value: string, query: string): number | undefined {
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

function skillSearchScore(item: SkillListItem, query: string): number | undefined {
	return codexFuzzyMatchScore(item.name, query);
}

function fuzzyMatch(value: string, query: string): boolean {
	return codexFuzzyMatchScore(value, query) !== undefined;
}

export default function skillControlExtension(pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const blockedPaths: BlockedSkillPaths = new Set();
	let currentCwd = process.cwd();
	let configError: string | undefined;
	let migrationNotice: string | undefined;
	let autocompleteInstalled = false;
	let promptMismatchWarningShown = false;

	const loadPolicy = (cwd: string) => {
		const policy = readPolicyConfig(configPath);
		currentCwd = cwd;
		replaceBlockedPaths(blockedPaths, policy.blockedPaths);
		configError = policy.error;
		if (policy.migrated && !configError) {
			try {
				writePolicyConfig(configPath, blockedPaths);
				migrationNotice = "Migrated legacy Skill policies to Unblocked / Blocked.";
			} catch {
				configError = "Could not migrate Skill control configuration";
			}
		}
	};

	loadPolicy(process.cwd());

	pi.on("session_start", (_event, ctx) => {
		loadPolicy(ctx.cwd);
		if (configError) ctx.ui.notify(configError, "error");
		else if (migrationNotice) {
			ctx.ui.notify(migrationNotice, "warning");
			migrationNotice = undefined;
		}
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
					return !blockedPaths.has(path);
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
		description: "Control availability for discovered skills",
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

			await ctx.ui.custom<SkillControlPanelResult>(
				(tui, theme, keybindings, done) =>
					new SkillControlPanel({
						tui,
						theme,
						keybindings,
						items,
						blockedPaths,
						userOnlyIcon: detectedUserOnlyIcon(),
						onApply(nextBlockedPaths) {
							try {
								if (!blockedPathsEqual(blockedPaths, nextBlockedPaths)) {
									writePolicyConfig(configPath, nextBlockedPaths);
								}
								replaceBlockedPaths(blockedPaths, nextBlockedPaths);
								configError = undefined;
							} catch {
								configError = "Could not write Skill control configuration";
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
		if (blockedPaths.size === 0) return;

		const skills = event.systemPromptOptions.skills ?? [];
		const filteredPrompt = applyBlockedSkillsToPrompt(event.systemPrompt, skills, blockedPaths, ctx.cwd);

		if (filteredPrompt === event.systemPrompt) {
			const modelPolicyDiffers = skills.some(
				(skill) =>
					blockedPaths.has(canonicalPath(skill.filePath, ctx.cwd)) && !skill.disableModelInvocation,
			);
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
		if (!blockedPaths.has(path)) return;
		ctx.ui.notify(`Skill '${skillName}' is blocked. Use /skills to change its policy.`, "warning");
		return { action: "handled" };
	});
}
