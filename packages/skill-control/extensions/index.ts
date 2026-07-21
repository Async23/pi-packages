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
	type PolicyScope,
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
	sourceScope: "user" | "project" | "temporary";
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

function accessSourceLabel(source: PolicyScope | "default"): string {
	if (source === "project") return "This project";
	if (source === "global") return "All projects";
	return "Skill default";
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
	globalOverrides: ReadonlyMap<string, SkillAccess>,
	projectOverrides: ReadonlyMap<string, SkillAccess>,
	cwd = process.cwd(),
): string {
	const originalSection = formatSkillsForPrompt([...skills]);
	const effectiveSkills = skills.flatMap((skill) => {
		const path = canonicalPath(skill.filePath, cwd);
		const resolved = resolveSkillAccess(
			path,
			defaultSkillAccess(skill),
			globalOverrides,
			projectOverrides,
		);
		if (!resolved.access.model) return [];
		return [{ ...skill, disableModelInvocation: false }];
	});
	const effectiveSection = formatSkillsForPrompt(effectiveSkills);
	return replaceSkillsSection(systemPrompt, originalSection, effectiveSection);
}

export type SkillControlPanelResult =
	| { action: "apply"; globalOverrides: SkillOverrides; projectOverrides: SkillOverrides }
	| { action: "close" };

interface StateDialog {
	path: string;
	scope: PolicyScope;
	selectedIndex: number;
}

export class SkillControlPanel implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #items: SkillListItem[];
	readonly #providers: ProviderTab[];
	readonly #initialGlobalOverrides: SkillOverrides;
	readonly #initialProjectOverrides: SkillOverrides;
	readonly #globalOverrides: SkillOverrides;
	readonly #projectOverrides: SkillOverrides;
	readonly #projectTrusted: boolean;
	readonly #onDone: (result: SkillControlPanelResult) => void;

	#query = "";
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
	#stateDialog: StateDialog | undefined;
	#confirmDiscard = false;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		items: SkillListItem[];
		globalOverrides: ReadonlyMap<string, SkillAccess>;
		projectOverrides: ReadonlyMap<string, SkillAccess>;
		projectTrusted?: boolean;
		onDone: (result: SkillControlPanelResult) => void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#items = options.items;
		this.#providers = PROVIDER_TABS.filter(
			(provider) => provider.id === "all" || options.items.some((item) => provider.match(item)),
		);
		this.#initialGlobalOverrides = cloneOverrides(options.globalOverrides);
		this.#initialProjectOverrides = cloneOverrides(options.projectOverrides);
		this.#globalOverrides = cloneOverrides(options.globalOverrides);
		this.#projectOverrides = cloneOverrides(options.projectOverrides);
		this.#projectTrusted = options.projectTrusted ?? true;
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
		if (this.#stateDialog) {
			this.#lastWidth = width;
			return this.#renderStateDialog(width);
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
		if (this.#stateDialog) {
			this.#handleStateDialogInput(data);
			this.#requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.#apply();
			return;
		}
		const wide = this.#lastWidth >= WIDE_LAYOUT_MIN_WIDTH;

		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			if (!wide && this.#narrowView === "preview") {
				this.#narrowView = "list";
				this.#focus = "list";
			} else if (this.#isDirty()) {
				this.#confirmDiscard = true;
			} else {
				this.#onDone({ action: "close" });
				return;
			}
			this.#requestRender();
			return;
		}

		if (matchesKey(data, Key.left)) {
			this.#moveProvider(-1);
			this.#requestRender();
			return;
		}
		if (matchesKey(data, Key.right)) {
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

	#isDirty(): boolean {
		return (
			!overridesEqual(this.#initialGlobalOverrides, this.#globalOverrides) ||
			!overridesEqual(this.#initialProjectOverrides, this.#projectOverrides)
		);
	}

	#pendingCount(): number {
		return (
			changedOverrideCount(this.#initialGlobalOverrides, this.#globalOverrides) +
			changedOverrideCount(this.#initialProjectOverrides, this.#projectOverrides)
		);
	}

	#apply(): void {
		if (!this.#isDirty()) {
			this.#onDone({ action: "close" });
			return;
		}
		this.#onDone({
			action: "apply",
			globalOverrides: cloneOverrides(this.#globalOverrides),
			projectOverrides: cloneOverrides(this.#projectOverrides),
		});
	}

	#resolutionFor(item: SkillListItem) {
		return resolveSkillAccess(
			item.path,
			item.defaultAccess,
			this.#globalOverrides,
			this.#projectOverrides,
		);
	}

	#stateFor(item: SkillListItem): SkillAccessState {
		return skillAccessState(this.#resolutionFor(item).access);
	}

	#scopeOverrides(scope: PolicyScope): SkillOverrides {
		return scope === "project" ? this.#projectOverrides : this.#globalOverrides;
	}

	#defaultScope(item: SkillListItem): PolicyScope {
		if (this.#projectTrusted && item.sourceScope !== "user") return "project";
		return "global";
	}

	#selectionFor(item: SkillListItem, scope: PolicyScope): number {
		const explicit = this.#scopeOverrides(scope).get(item.path);
		const inherited =
			scope === "project"
				? resolveSkillAccess(item.path, item.defaultAccess, this.#globalOverrides, new Map()).access
				: item.defaultAccess;
		const state = skillAccessState(explicit ?? inherited);
		return Math.max(0, ACCESS_STATE_ORDER.indexOf(state));
	}

	#inheritedStateFor(item: SkillListItem, scope: PolicyScope): SkillAccessState {
		if (scope === "global") return skillAccessState(item.defaultAccess);
		return skillAccessState(
			resolveSkillAccess(item.path, item.defaultAccess, this.#globalOverrides, new Map()).access,
		);
	}

	#openStateDialog(): void {
		const item = this.#currentItem();
		if (!item) return;
		const scope = this.#defaultScope(item);
		this.#stateDialog = {
			path: item.path,
			scope,
			selectedIndex: this.#selectionFor(item, scope),
		};
		this.#flash = undefined;
	}

	#handleStateDialogInput(data: string): void {
		const dialog = this.#stateDialog;
		if (!dialog) return;
		const item = this.#items.find((candidate) => candidate.path === dialog.path);
		if (!item) {
			this.#stateDialog = undefined;
			return;
		}

		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#stateDialog = undefined;
			return;
		}
		if (matchesKey(data, Key.tab)) {
			if (!this.#projectTrusted) {
				this.#flash = { kind: "warning", text: "This project access requires a trusted project" };
				return;
			}
			dialog.scope = dialog.scope === "global" ? "project" : "global";
			dialog.selectedIndex = this.#selectionFor(item, dialog.scope);
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.up")) {
			dialog.selectedIndex = (dialog.selectedIndex + ACCESS_STATE_ORDER.length) % (ACCESS_STATE_ORDER.length + 1);
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.down")) {
			dialog.selectedIndex = (dialog.selectedIndex + 1) % (ACCESS_STATE_ORDER.length + 1);
			return;
		}
		if (!this.#keybindings.matches(data, "tui.select.confirm")) return;

		const overrides = this.#scopeOverrides(dialog.scope);
		if (dialog.selectedIndex === ACCESS_STATE_ORDER.length) {
			overrides.delete(item.path);
		} else {
			const state = ACCESS_STATE_ORDER[dialog.selectedIndex];
			if (state) overrides.set(item.path, accessForState(state));
		}
		this.#stateDialog = undefined;
		const pending = this.#pendingCount();
		this.#flash = pending > 0 ? { kind: "warning", text: `Pending ${pending}` } : { kind: "success", text: "No pending changes" };
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

	#renderStateDialog(width: number): string[] {
		if (width < 4) return [truncateToWidth("Skill access", width, "")];
		const innerWidth = width - 2;
		const dialog = this.#stateDialog;
		const item = dialog ? this.#items.find((candidate) => candidate.path === dialog.path) : undefined;
		if (!dialog || !item) return [truncateToWidth("Skill access", width, "")];

		const scopeText = [
			dialog.scope === "global"
				? this.#theme.fg("accent", this.#theme.bold("[All projects]"))
				: this.#theme.fg("muted", "All projects"),
			dialog.scope === "project"
				? this.#theme.fg("accent", this.#theme.bold("[This project]"))
				: this.#theme.fg("muted", "This project"),
		].join("  ");
		const explicitAccess = this.#scopeOverrides(dialog.scope).get(item.path);
		const inheritedState = this.#inheritedStateFor(item, dialog.scope);
		const currentState = explicitAccess ? skillAccessState(explicitAccess) : inheritedState;
		const currentSource = explicitAccess
			? dialog.scope === "global"
				? "saved for All projects"
				: "saved for This project"
			: dialog.scope === "project" && this.#globalOverrides.has(item.path)
				? "from All projects"
				: "from Skill default";
		const lines = this.#topBorder(width, "Who can use this Skill?");
		lines.push(this.#fullLine(this.#theme.fg("accent", this.#theme.bold(item.name)), innerWidth));
		lines.push(this.#fullLine(`${this.#theme.fg("muted", "Save for")}  ${scopeText}`, innerWidth));
		lines.push(
			this.#fullLine(
				`${this.#theme.fg("muted", "Current")}  ${this.#theme.fg("text", accessStateLabel(currentState))}${this.#theme.fg(
					"dim",
					` · ${currentSource}`,
				)}`,
				innerWidth,
			),
		);
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
			const selected = dialog.selectedIndex === index;
			const icon = this.#stateIcon(state);
			const label = this.#theme.fg(selected ? "accent" : "text", accessStateLabel(state));
			const access = accessForState(state);
			const permissions = this.#accessColumns(
				this.#theme.fg(access.model ? "accent" : "dim", access.model ? "✓" : "—"),
				this.#theme.fg(access.user ? "warning" : "dim", access.user ? "✓" : "—"),
			);
			lines.push(this.#fullLine(this.#joined(`${icon}  ${label}`, permissions, innerWidth - 2), innerWidth, selected));
		}
		const resetSelected = dialog.selectedIndex === ACCESS_STATE_ORDER.length;
		const inheritedSource =
			dialog.scope === "project" && this.#globalOverrides.has(item.path)
				? "Use All projects setting"
				: "Use Skill default";
		lines.push(
			this.#fullLine(
				this.#joined(
					`${this.#theme.fg("muted", "↩")}  ${this.#theme.fg(resetSelected ? "accent" : "text", "Use inherited access")}`,
					this.#theme.fg("dim", inheritedSource),
					innerWidth - 2,
				),
				innerWidth,
				resetSelected,
			),
		);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help = this.#projectTrusted
			? "↑↓ select   Tab change scope   Enter choose   Esc cancel"
			: "↑↓ select   Enter choose   Esc cancel";
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
		return providerItems.filter((item) =>
			`${item.name} ${item.label} ${item.description} ${item.sourceLabel} ${item.path}`
				.toLowerCase()
				.includes(normalizedQuery),
		);
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

	#toggleCurrentItem(): void {
		this.#openStateDialog();
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
		const placeholder = width >= 42 ? "type to filter skills" : "filter skills";
		return this.#query
			? `${this.#theme.fg("text", this.#query)}${this.#theme.fg("accent", "_")}`
			: `${this.#theme.fg("dim", placeholder)}${this.#theme.fg("accent", "_")}`;
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
			const icon = this.#stateIcon(state);
			const label = selected
				? this.#theme.fg("accent", this.#theme.bold(row.item.name))
				: state === "neither"
					? this.#theme.fg("dim", row.item.name)
					: this.#theme.fg("text", row.item.name);
			const badge = this.#theme.fg(
				state === "neither" ? "dim" : state === "user" ? "warning" : "muted",
				accessStateLabel(state),
			);
			const content = this.#joined(`${icon}  ${label}`, badge, Math.max(0, width - 2));
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

	#previewMetadata(item: SkillListItem, width: number): string[] {
		const bytes = new TextEncoder().encode(item.content).length;
		const metadata = `${lineCount(item.content)} lines · ${formatBytes(bytes)} · ~${formatCount(estimateTokens(item.content))} tokens`;
		const name = truncateToWidth(item.name, Math.max(1, width - 2), "…");
		const description = truncateToWidth(item.description, Math.max(1, width - 2), "…");
		const resolution = this.#resolutionFor(item);
		const state = skillAccessState(resolution.access);
		const sourceLine = truncateToWidth(
			`${item.sourceLabel} · ${accessStateLabel(state)} · ${accessSourceLabel(resolution.source)}`,
			Math.max(1, width - 2),
			"…",
		);
		return [
			this.#paneContent(this.#theme.fg("accent", this.#theme.bold(name)), width),
			this.#paneContent(this.#theme.fg("muted", sourceLine), width),
			this.#paneContent(this.#theme.fg("dim", description), width),
			this.#paneContent(this.#theme.fg("dim", metadata), width),
		];
	}

	#renderPreviewRows(width: number, height: number): string[] {
		const item = this.#currentItem();
		if (!item) {
			const message = this.#items.length === 0 ? "No skill content to preview." : "Edit the search to select a skill.";
			return [
				this.#paneContent(this.#theme.fg("muted", message), width),
				...Array.from({ length: height - 1 }, () => " ".repeat(width)),
			];
		}

		const metadata = this.#previewMetadata(item, width);
		const spacerCount = height >= 10 ? 2 : height >= 8 ? 1 : 0;
		const previewHeight = Math.max(1, height - metadata.length - 1 - spacerCount);
		const contentWidth = Math.max(1, width - 2);
		const previewLines = this.#previewLines(item, contentWidth);
		this.#lastPreviewLineCount = previewLines.length;
		this.#lastPreviewViewportHeight = previewHeight;
		this.#previewOffset = Math.max(
			0,
			Math.min(this.#previewOffset, Math.max(0, previewLines.length - previewHeight)),
		);

		const position =
			previewLines.length === 0
				? ""
				: ` · View ${this.#previewOffset + 1}–${Math.min(this.#previewOffset + previewHeight, previewLines.length)} of ${previewLines.length} wrapped rows`;
		const dividerWidth = Math.max(0, width - 2);
		const dividerPrefix = this.#theme.fg("borderMuted", "─ ");
		const dividerTitle = this.#theme.fg("accent", this.#theme.bold("SKILL.md"));
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
		const content =
			previewLines.length === 0
				? [this.#paneContent(this.#theme.fg("warning", "This skill file is empty or unreadable."), width)]
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
		for (const searchLine of this.#labeledTextLines("Search", this.#searchValue(headerWidth), headerWidth)) {
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
		const help = "←/→ source   ↑↓ select/scroll   Tab pane   Space access   Ctrl+S apply   Esc close";
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
		for (const searchLine of this.#labeledTextLines("Search", this.#searchValue(headerWidth), headerWidth)) {
			lines.push(this.#fullLine(searchLine, innerWidth));
		}
		lines.push(
			`${this.#theme.fg("borderMuted", "├")}${this.#sectionSegment("Skills", innerWidth, true)}${this.#theme.fg("borderMuted", "┤")}`,
		);
		const chromeAfterContent = 5; // selected path + status + separators + help + bottom
		const contentHeight = Math.max(
			3,
			Math.min(16, this.#preferredOverlayHeight() - lines.length - chromeAfterContent),
		);
		const listRows = this.#renderListRows(innerWidth, contentHeight, true);
		for (const row of listRows) lines.push(`${this.#theme.fg("borderMuted", "│")}${row}${this.#theme.fg("borderMuted", "│")}`);
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const selected = this.#currentItem();
		if (selected) {
			const resolution = this.#resolutionFor(selected);
			const state = skillAccessState(resolution.access);
			lines.push(this.#fullLine(this.#theme.fg("text", selected.label), innerWidth));
			lines.push(
				this.#fullLine(
					this.#theme.fg(
						state === "neither" ? "warning" : "muted",
						`${selected.sourceLabel} · ${accessStateLabel(state)} · ${accessSourceLabel(resolution.source)}`,
					),
					innerWidth,
				),
			);
		} else {
			lines.push(this.#fullLine(this.#theme.fg("dim", "Edit search to select a skill."), innerWidth));
			lines.push(this.#fullLine("", innerWidth));
		}
		lines.push(this.#border("├", "─", "┤", innerWidth));
		const help =
			width >= 66
				? "←/→ source   ↑↓ select   Enter preview   Space access   Ctrl+S apply"
				: "←/→ source   ↑↓ select   Space access";
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
			width >= 62
				? "↑↓/PgUp/PgDn scroll   Space access   Ctrl+S apply   Enter/Esc back"
				: "↑↓ scroll   Space access   Esc back";
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
				sourceScope: skill.sourceInfo.scope,
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

function fuzzyCommandMatch(value: string, query: string): boolean {
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
	const globalConfigPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const globalOverrides: SkillOverrides = new Map();
	const projectOverrides: SkillOverrides = new Map();
	let currentCwd = process.cwd();
	let projectConfigPath = join(currentCwd, ".pi", CONFIG_FILE_NAME);
	let configError: string | undefined;
	let autocompleteInstalled = false;
	let promptMismatchWarningShown = false;

	const loadPolicies = (cwd: string, projectTrusted: boolean) => {
		const global = readPolicyConfig(globalConfigPath);
		currentCwd = cwd;
		projectConfigPath = join(cwd, ".pi", CONFIG_FILE_NAME);
		const project: ReturnType<typeof readPolicyConfig> = projectTrusted
			? readPolicyConfig(projectConfigPath)
			: { overrides: new Map(), migrated: false };
		replaceOverrides(globalOverrides, global.overrides);
		replaceOverrides(projectOverrides, project.overrides);
		configError = global.error ?? project.error;
	};

	loadPolicies(process.cwd(), false);

	pi.on("session_start", (_event, ctx) => {
		loadPolicies(ctx.cwd, ctx.isProjectTrusted());
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
					return resolveUserAccess(path, globalOverrides, projectOverrides);
				});
				const blockedNames = new Set(
					skillCommands
						.filter((command) => !allowedCommands.includes(command))
						.map((command) => command.name),
				);
				const items = (delegated?.items ?? []).filter((item) => !blockedNames.has(item.value));
				const existing = new Set(items.map((item) => item.value));
				for (const command of allowedCommands) {
					if (existing.has(command.name) || !fuzzyCommandMatch(command.name, query)) continue;
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
						globalOverrides,
						projectOverrides,
						projectTrusted: ctx.isProjectTrusted(),
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

			const globalChanged = !overridesEqual(globalOverrides, result.globalOverrides);
			const projectChanged = !overridesEqual(projectOverrides, result.projectOverrides);
			const changeCount =
				changedOverrideCount(globalOverrides, result.globalOverrides) +
				changedOverrideCount(projectOverrides, result.projectOverrides);
			try {
				if (globalChanged) writePolicyConfig(globalConfigPath, result.globalOverrides);
				if (projectChanged) writePolicyConfig(projectConfigPath, result.projectOverrides);
				replaceOverrides(globalOverrides, result.globalOverrides);
				replaceOverrides(projectOverrides, result.projectOverrides);
				configError = undefined;
				ctx.ui.notify(`Applied ${changeCount} Skill ${changeCount === 1 ? "change" : "changes"}`, "info");
			} catch {
				configError = "Could not write Skill control configuration";
				ctx.ui.notify(configError, "error");
			}
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (globalOverrides.size === 0 && projectOverrides.size === 0) return;

		const skills = event.systemPromptOptions.skills ?? [];
		const filteredPrompt = applySkillAccessToPrompt(
			event.systemPrompt,
			skills,
			globalOverrides,
			projectOverrides,
			ctx.cwd,
		);

		if (filteredPrompt === event.systemPrompt) {
			const modelPolicyDiffers = skills.some((skill) => {
				const path = canonicalPath(skill.filePath, ctx.cwd);
				const access = resolveSkillAccess(
					path,
					defaultSkillAccess(skill),
					globalOverrides,
					projectOverrides,
				).access;
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
		if (resolveUserAccess(path, globalOverrides, projectOverrides)) return;
		ctx.ui.notify(`Skill '${skillName}' isn't available through /skill. Use /skills to change access.`, "warning");
		return { action: "handled" };
	});
}
