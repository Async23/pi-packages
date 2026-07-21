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
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";

const CONFIG_VERSION = 2;
const CONFIG_FILE_NAME = "skill-control.json";
const WIDE_LAYOUT_MIN_WIDTH = 92;

export type SkillSourceKind =
	| "agents"
	| "pi"
	| "claude"
	| "codex"
	| "opencode"
	| "package"
	| "project"
	| "other";

export type SkillVisibility = "model" | "manual" | "excluded";

type PanelFocus = "list" | "preview";
type NarrowView = "list" | "preview";
type FlashKind = "success" | "error";

export interface DiscoverConfig {
	claudeUser: boolean;
	codexUser: boolean;
	opencodeUser: boolean;
	claudeProject: boolean;
	codexProject: boolean;
	customPaths: string[];
}

interface SkillControlConfig {
	version: number;
	disabledPaths: string[];
	discover: DiscoverConfig;
}

interface SkillListItem {
	path: string;
	name: string;
	label: string;
	description: string;
	sourceKind: SkillSourceKind;
	sourceLabel: string;
	content: string;
	disableModelInvocation: boolean;
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

const DEFAULT_DISCOVER: DiscoverConfig = {
	claudeUser: false,
	codexUser: false,
	opencodeUser: false,
	claudeProject: false,
	codexProject: false,
	customPaths: [],
};

const SOURCE_ORDER: SkillSourceKind[] = [
	"agents",
	"pi",
	"claude",
	"codex",
	"opencode",
	"package",
	"project",
	"other",
];

const ALL_PROVIDERS_TAB = "ALL";

interface ProviderTab {
	id: string;
	label: string;
	shortLabel: string;
	group: ProviderGroupId;
	match: (item: SkillListItem) => boolean;
}

type ProviderGroupId = "scope" | "user" | "project" | "other";

const PROVIDER_GROUPS: { id: ProviderGroupId; label: string }[] = [
	{ id: "scope", label: "Scope" },
	{ id: "user", label: "User" },
	{ id: "project", label: "Project" },
	{ id: "other", label: "Other" },
];

const PROVIDER_TABS: ProviderTab[] = [
	{ id: "all", label: ALL_PROVIDERS_TAB, shortLabel: "ALL", group: "scope", match: () => true },
	{
		id: "agents-user",
		label: "Agents (user)",
		shortLabel: "Agents",
		group: "user",
		match: (item) => item.sourceLabel === "Agents (user)",
	},
	{
		id: "pi-user",
		label: "Pi (user)",
		shortLabel: "Pi",
		group: "user",
		match: (item) => item.sourceLabel === "Pi (user)",
	},
	{
		id: "claude-user",
		label: "Claude (user)",
		shortLabel: "Claude",
		group: "user",
		match: (item) => item.sourceLabel === "Claude (user)",
	},
	{
		id: "codex-user",
		label: "Codex (user)",
		shortLabel: "Codex",
		group: "user",
		match: (item) => item.sourceLabel === "Codex (user)",
	},
	{
		id: "opencode-user",
		label: "OpenCode (user)",
		shortLabel: "OpenCode",
		group: "user",
		match: (item) => item.sourceLabel === "OpenCode (user)",
	},
	{
		id: "agents-project",
		label: "Agents (project)",
		shortLabel: "Agents",
		group: "project",
		match: (item) => item.sourceLabel === "Agents (project)",
	},
	{
		id: "pi-project",
		label: "Pi (project)",
		shortLabel: "Pi",
		group: "project",
		match: (item) => item.sourceLabel === "Pi (project)",
	},
	{
		id: "claude-project",
		label: "Claude (project)",
		shortLabel: "Claude",
		group: "project",
		match: (item) => item.sourceLabel === "Claude (project)",
	},
	{
		id: "codex-project",
		label: "Codex (project)",
		shortLabel: "Codex",
		group: "project",
		match: (item) => item.sourceLabel === "Codex (project)",
	},
	{
		id: "opencode-project",
		label: "OpenCode (project)",
		shortLabel: "OpenCode",
		group: "project",
		match: (item) => item.sourceLabel === "OpenCode (project)",
	},
	{
		id: "package",
		label: "Package",
		shortLabel: "Package",
		group: "other",
		match: (item) => item.sourceKind === "package",
	},
	{
		id: "project",
		label: "Project",
		shortLabel: "Project",
		group: "other",
		match: (item) => item.sourceLabel === "Project",
	},
	{
		id: "other",
		label: "Other",
		shortLabel: "Other",
		group: "other",
		match: (item) => item.sourceLabel === "Other",
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiscoverConfig(value: unknown): value is DiscoverConfig {
	return (
		isRecord(value) &&
		typeof value.claudeUser === "boolean" &&
		typeof value.codexUser === "boolean" &&
		typeof value.opencodeUser === "boolean" &&
		typeof value.claudeProject === "boolean" &&
		typeof value.codexProject === "boolean" &&
		Array.isArray(value.customPaths) &&
		value.customPaths.every((path) => typeof path === "string")
	);
}

function normalizeDiscover(value: unknown): DiscoverConfig {
	if (!isRecord(value)) return { ...DEFAULT_DISCOVER };
	return {
		claudeUser: value.claudeUser === true,
		codexUser: value.codexUser === true,
		opencodeUser: value.opencodeUser === true,
		claudeProject: value.claudeProject === true,
		codexProject: value.codexProject === true,
		customPaths: Array.isArray(value.customPaths)
			? value.customPaths.filter((path): path is string => typeof path === "string")
			: [],
	};
}

function isSkillControlConfig(value: unknown): value is SkillControlConfig {
	return (
		isRecord(value) &&
		(value.version === 1 || value.version === CONFIG_VERSION) &&
		Array.isArray(value.disabledPaths) &&
		value.disabledPaths.every((path) => typeof path === "string") &&
		(value.version === 1 || value.discover === undefined || isDiscoverConfig(value.discover) || isRecord(value.discover))
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

export function displayPath(filePath: string): string {
	const home = homedir();
	if (filePath === home) return "~";
	if (filePath.startsWith(`${home}${sep}`)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

function expandUserPath(rawPath: string, cwd: string, home = homedir()): string {
	const trimmed = rawPath.trim();
	if (trimmed === "~") return home;
	if (trimmed.startsWith(`~${sep}`)) return join(home, trimmed.slice(2));
	return resolve(cwd, trimmed);
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

	if (skill.sourceInfo.scope === "project") return { kind: "project", label: "Project" };
	return { kind: "other", label: "Other" };
}

export function skillVisibility(item: Pick<SkillListItem, "path" | "disableModelInvocation">, disabledPaths: ReadonlySet<string>): SkillVisibility {
	if (disabledPaths.has(item.path)) return "excluded";
	if (item.disableModelInvocation) return "manual";
	return "model";
}

export function visibilityLabel(visibility: SkillVisibility): string {
	switch (visibility) {
		case "excluded":
			return "Excluded from prompt";
		case "manual":
			return "Manual /skill:name only";
		case "model":
			return "Visible to model";
	}
}

export function resolveDiscoverSkillPaths(
	discover: DiscoverConfig,
	cwd: string,
	home = homedir(),
): string[] {
	const paths: string[] = [];
	if (discover.claudeUser) paths.push(join(home, ".claude", "skills"));
	if (discover.codexUser) paths.push(join(home, ".codex", "skills"));
	if (discover.opencodeUser) paths.push(join(home, ".config", "opencode", "skills"));
	if (discover.claudeProject) paths.push(join(cwd, ".claude", "skills"));
	if (discover.codexProject) paths.push(join(cwd, ".codex", "skills"));
	for (const custom of discover.customPaths) {
		const expanded = expandUserPath(custom, cwd, home);
		if (expanded) paths.push(expanded);
	}

	const seen = new Set<string>();
	const unique: string[] = [];
	for (const path of paths) {
		const key = normalize(path);
		if (seen.has(key)) continue;
		seen.add(key);
		if (existsSync(key)) unique.push(key);
	}
	return unique;
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
	enabledSection: string,
): string {
	if (!originalSection || originalSection === enabledSection) return systemPrompt;
	const sectionIndex = systemPrompt.lastIndexOf(originalSection);
	if (sectionIndex === -1) return systemPrompt;
	return `${systemPrompt.slice(0, sectionIndex)}${enabledSection}${systemPrompt.slice(sectionIndex + originalSection.length)}`;
}

export function filterAvailableSkills(
	systemPrompt: string,
	skills: readonly Skill[],
	disabledPaths: ReadonlySet<string>,
	cwd = process.cwd(),
): string {
	const enabledSkills = skills.filter((skill) => !disabledPaths.has(canonicalPath(skill.filePath, cwd)));
	if (enabledSkills.length === skills.length) return systemPrompt;

	const originalSection = formatSkillsForPrompt([...skills]);
	const enabledSection = formatSkillsForPrompt([...enabledSkills]);
	return replaceSkillsSection(systemPrompt, originalSection, enabledSection);
}

function readConfig(configPath: string): {
	disabledPaths: Set<string>;
	discover: DiscoverConfig;
	error?: string;
} {
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (!isSkillControlConfig(parsed)) {
			return {
				disabledPaths: new Set(),
				discover: { ...DEFAULT_DISCOVER },
				error: `Invalid skill control config: ${configPath}`,
			};
		}
		return {
			disabledPaths: new Set(parsed.disabledPaths.map((path) => canonicalPath(path))),
			discover: normalizeDiscover(parsed.discover),
		};
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return { disabledPaths: new Set(), discover: { ...DEFAULT_DISCOVER } };
		}
		return {
			disabledPaths: new Set(),
			discover: { ...DEFAULT_DISCOVER },
			error: `Could not read skill control config: ${configPath}`,
		};
	}
}

function writeConfig(
	configPath: string,
	disabledPaths: ReadonlySet<string>,
	discover: DiscoverConfig,
): void {
	const config: SkillControlConfig = {
		version: CONFIG_VERSION,
		disabledPaths: [...disabledPaths].sort(),
		discover: {
			...discover,
			customPaths: [...discover.customPaths],
		},
	};
	const temporaryPath = `${configPath}.${process.pid}.tmp`;
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, configPath);
}

export class SkillControlPanel implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #items: SkillListItem[];
	readonly #disabledPaths: Set<string>;
	readonly #discoverSummary: string;
	readonly #onToggle: (path: string) => string | undefined;
	readonly #onClose: () => void;

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

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		items: SkillListItem[];
		disabledPaths: Set<string>;
		discoverSummary: string;
		onToggle: (path: string) => string | undefined;
		onClose: () => void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#items = options.items;
		this.#disabledPaths = options.disabledPaths;
		this.#discoverSummary = options.discoverSummary;
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
		if (width < 4) return [truncateToWidth("Skills", width, "")];
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

	#activeProvider(): ProviderTab {
		return PROVIDER_TABS[this.#providerIndex] ?? PROVIDER_TABS[0];
	}

	#moveProvider(delta: number): void {
		this.#providerIndex = (this.#providerIndex + delta + PROVIDER_TABS.length) % PROVIDER_TABS.length;
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

	#summaryEntries(): { text: string; width: number }[] {
		const scoped = this.#providerItems();
		let modelCount = 0;
		let manualCount = 0;
		let excludedCount = 0;
		for (const item of scoped) {
			const visibility = skillVisibility(item, this.#disabledPaths);
			if (visibility === "model") modelCount += 1;
			else if (visibility === "manual") manualCount += 1;
			else excludedCount += 1;
		}
		const entries = [
			`${this.#theme.fg("accent", "●")} ${this.#theme.fg("text", `${modelCount} model`)}`,
			`${this.#theme.fg("warning", "◐")} ${this.#theme.fg("muted", `${manualCount} manual`)}`,
			`${this.#theme.fg(excludedCount > 0 ? "warning" : "dim", "○")} ${this.#theme.fg(
				excludedCount > 0 ? "warning" : "dim",
				`${excludedCount} excluded`,
			)}`,
		];
		return entries.map((text) => ({ text, width: visibleWidth(text) }));
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

		const lines: string[] = [];
		for (const group of PROVIDER_GROUPS) {
			const entries = PROVIDER_TABS.flatMap((provider, index) => {
				if (provider.group !== group.id) return [];
				const count = this.#providerCount(provider);
				const empty = count === 0 && provider.id !== "all";
				const label = `${provider.shortLabel} ${count}`;
				const text = style(label, index, empty);
				return [{ text, width: visibleWidth(text) }];
			});
			lines.push(...this.#labeledEntryLines(group.label, entries, width));
		}
		return lines;
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
						: provider.id === "all"
							? "No skills discovered."
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
			const visibility = skillVisibility(row.item, this.#disabledPaths);
			const icon =
				visibility === "excluded"
					? this.#theme.fg("dim", "○")
					: visibility === "manual"
						? this.#theme.fg("warning", "◐")
						: this.#theme.fg("accent", "●");
			const label = selected
				? this.#theme.fg("accent", this.#theme.bold(row.item.name))
				: visibility === "excluded"
					? this.#theme.fg("dim", row.item.name)
					: this.#theme.fg("text", row.item.name);
			const badge =
				visibility === "excluded"
					? this.#theme.fg("dim", "Excluded")
					: visibility === "manual"
						? this.#theme.fg("warning", "Manual")
						: this.#theme.fg("dim", "Model");
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
		const visibility = skillVisibility(item, this.#disabledPaths);
		const sourceLine = truncateToWidth(
			`${item.sourceLabel} · ${visibilityLabel(visibility)}`,
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
		const styledFlash = this.#theme.fg(this.#flash.kind === "error" ? "error" : "success", this.#flash.text);
		if (this.#flash.kind === "error") return styledFlash;
		return this.#joined(styledHelp, styledFlash, width);
	}

	#renderWide(width: number): string[] {
		const innerWidth = width - 2;
		const headerWidth = Math.max(1, innerWidth - 2);
		const listWidth = Math.min(44, Math.max(32, Math.floor(innerWidth * 0.38)));
		const previewWidth = innerWidth - listWidth - 1;
		const lines = this.#topBorder(width, "Skills");
		for (const summaryLine of this.#labeledEntryLines("Visibility", this.#summaryEntries(), headerWidth)) {
			lines.push(this.#fullLine(summaryLine, innerWidth));
		}
		for (const tabLine of this.#providerTabLines(headerWidth)) {
			lines.push(this.#fullLine(tabLine, innerWidth));
		}
		for (const discoveryLine of this.#labeledTextLines(
			"Extra paths",
			this.#theme.fg("dim", this.#discoverSummary),
			headerWidth,
		)) {
			lines.push(this.#fullLine(discoveryLine, innerWidth));
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
		const help = "←/→ provider   ↑↓ select/scroll   Tab pane   Space toggle   Esc close";
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
		for (const summaryLine of this.#labeledEntryLines("Visibility", this.#summaryEntries(), headerWidth)) {
			lines.push(this.#fullLine(summaryLine, innerWidth));
		}
		for (const tabLine of this.#providerTabLines(headerWidth)) {
			lines.push(this.#fullLine(tabLine, innerWidth));
		}
		for (const discoveryLine of this.#labeledTextLines(
			"Extra paths",
			this.#theme.fg("dim", this.#discoverSummary),
			headerWidth,
		)) {
			lines.push(this.#fullLine(discoveryLine, innerWidth));
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
			const visibility = skillVisibility(selected, this.#disabledPaths);
			lines.push(this.#fullLine(this.#theme.fg("text", selected.label), innerWidth));
			lines.push(
				this.#fullLine(
					this.#theme.fg(
						visibility === "excluded" ? "warning" : "muted",
						`${selected.sourceLabel} · ${visibilityLabel(visibility)}`,
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
			width >= 55 ? "←/→ provider   ↑↓ select   Enter preview   Space toggle" : "←/→ provider   ↑↓ select   Space";
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
		const help = width >= 55 ? "↑↓/PgUp/PgDn scroll   Space toggle   Enter/Esc back" : "↑↓ scroll   Space toggle   Esc back";
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
				disableModelInvocation: skill.disableModelInvocation,
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

export function discoverSummary(discover: DiscoverConfig): string {
	const enabled: string[] = [];
	if (discover.claudeUser) enabled.push("claude");
	if (discover.codexUser) enabled.push("codex");
	if (discover.opencodeUser) enabled.push("opencode");
	if (discover.claudeProject) enabled.push("claude-project");
	if (discover.codexProject) enabled.push("codex-project");
	if (discover.customPaths.length > 0) enabled.push(`custom×${discover.customPaths.length}`);
	if (enabled.length === 0) return "Off · edit ~/.pi/agent/skill-control.json";
	return `${enabled.join(", ")} · /reload after edits`;
}

export default function skillControlExtension(pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const loadedConfig = readConfig(configPath);
	const disabledPaths = loadedConfig.disabledPaths;
	const discover = loadedConfig.discover;
	let configError = loadedConfig.error;
	let promptMismatchWarningShown = false;

	pi.on("resources_discover", (event) => {
		const skillPaths = resolveDiscoverSkillPaths(discover, event.cwd);
		if (skillPaths.length === 0) return;
		return { skillPaths };
	});

	pi.registerCommand("skills", {
		description: "Enable or disable loaded skills",
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

			await ctx.ui.custom(
				(tui, theme, keybindings, done) =>
					new SkillControlPanel({
						tui,
						theme,
						keybindings,
						items,
						disabledPaths,
						discoverSummary: discoverSummary(discover),
						onToggle: (path) => {
							const wasDisabled = disabledPaths.has(path);
							if (wasDisabled) disabledPaths.delete(path);
							else disabledPaths.add(path);

							try {
								writeConfig(configPath, disabledPaths, discover);
								return undefined;
							} catch {
								if (wasDisabled) disabledPaths.add(path);
								else disabledPaths.delete(path);
								configError = `Could not write skill control config: ${configPath}`;
								ctx.ui.notify(configError, "error");
								return "Could not save Skill settings";
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

		const skills = event.systemPromptOptions.skills ?? [];
		const filteredPrompt = filterAvailableSkills(event.systemPrompt, skills, disabledPaths, ctx.cwd);
		const hasDisabledLoadedSkill = skills.some((skill) => disabledPaths.has(canonicalPath(skill.filePath, ctx.cwd)));

		if (filteredPrompt === event.systemPrompt) {
			if (hasDisabledLoadedSkill && !promptMismatchWarningShown) {
				const originalSection = formatSkillsForPrompt([...skills]);
				if (originalSection.length > 0) {
					promptMismatchWarningShown = true;
					ctx.ui.notify("Skill control could not locate Pi's available skills section.", "warning");
				}
			}
			return;
		}

		promptMismatchWarningShown = false;
		return { systemPrompt: filteredPrompt };
	});
}
