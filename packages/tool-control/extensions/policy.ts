import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { basename, dirname, extname, sep } from "node:path";
import type { McpToolInventoryItemV1, McpToolInventorySnapshotV1 } from "./inventory-protocol.ts";

export const TOOL_SELECTION_ENTRY_TYPE = "tool-control-selection";
export const TOOL_SELECTION_ENTRY_VERSION = 1;

export interface ToolSelectionEntryV1 {
	version: typeof TOOL_SELECTION_ENTRY_VERSION;
	inactiveToolNames: string[];
}

export interface ToolSelectionRuntime {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	appendEntry<T = unknown>(customType: string, data?: T): void;
}

export type ToolSourceKind = "builtin" | "mcp" | "extension" | "sdk";

export interface ToolCatalogItem {
	tool: ToolInfo;
	name: string;
	sourceKind: ToolSourceKind;
	registrar: string;
	groupKey: string;
	groupLabel: string;
	inventoryItem?: McpToolInventoryItemV1;
}

export interface ToolReconciliationResult {
	activeToolNames: string[];
	inactiveToolNames: Set<string>;
	availableTools: ToolInfo[];
}

export interface CurrentToolSelection {
	items: ToolCatalogItem[];
	activeToolNames: Set<string>;
	inactiveToolNames: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedUniqueNames(values: Iterable<string>): string[] {
	return [...new Set([...values].filter((value) => value.length > 0))].sort((left, right) => left.localeCompare(right));
}

export function decodeToolSelectionEntry(value: unknown): ToolSelectionEntryV1 | undefined {
	if (!isRecord(value) || value.version !== TOOL_SELECTION_ENTRY_VERSION || !Array.isArray(value.inactiveToolNames)) {
		return undefined;
	}
	if (!value.inactiveToolNames.every((name) => typeof name === "string" && name.length > 0)) return undefined;
	return {
		version: TOOL_SELECTION_ENTRY_VERSION,
		inactiveToolNames: sortedUniqueNames(value.inactiveToolNames),
	};
}

function latestToolSelectionEntry(entries: readonly SessionEntry[]): ToolSelectionEntryV1 | undefined {
	let restored: ToolSelectionEntryV1 | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_ENTRY_TYPE) continue;
		const decoded = decodeToolSelectionEntry(entry.data);
		if (decoded) restored = decoded;
	}
	return restored;
}

export function restoreInactiveToolNames(entries: readonly SessionEntry[]): Set<string> {
	return new Set(latestToolSelectionEntry(entries)?.inactiveToolNames ?? []);
}

export function encodeToolSelectionEntry(inactiveToolNames: ReadonlySet<string>): ToolSelectionEntryV1 {
	return {
		version: TOOL_SELECTION_ENTRY_VERSION,
		inactiveToolNames: sortedUniqueNames(inactiveToolNames),
	};
}

export function toolNameSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const name of left) {
		if (!right.has(name)) return false;
	}
	return true;
}

export function changedToolCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	let count = 0;
	for (const name of new Set([...left, ...right])) {
		if (left.has(name) !== right.has(name)) count += 1;
	}
	return count;
}

function inventoryMap(snapshot: McpToolInventorySnapshotV1 | undefined): Map<string, McpToolInventoryItemV1> {
	return new Map(snapshot?.tools.map((item) => [item.toolName, item]) ?? []);
}

export function availableTools(
	tools: readonly ToolInfo[],
	snapshot: McpToolInventorySnapshotV1 | undefined,
): ToolInfo[] {
	const inventory = inventoryMap(snapshot);
	return tools.filter((tool) => inventory.get(tool.name)?.available !== false);
}

function packageNameFromPath(path: string): string | undefined {
	const parts = path.split(/[\\/]+/);
	const nodeModules = parts.lastIndexOf("node_modules");
	if (nodeModules < 0 || nodeModules + 1 >= parts.length) return undefined;
	const first = parts[nodeModules + 1];
	if (!first) return undefined;
	if (first.startsWith("@") && parts[nodeModules + 2]) return `${first}/${parts[nodeModules + 2]}`;
	return first;
}

function extensionLabel(tool: ToolInfo): string {
	const packageName = packageNameFromPath(tool.sourceInfo.path);
	if (packageName) return packageName;
	const genericSources = new Set(["local", "path", "extension", "temporary"]);
	if (tool.sourceInfo.source && !genericSources.has(tool.sourceInfo.source)) return tool.sourceInfo.source;
	let directory = tool.sourceInfo.baseDir ?? dirname(tool.sourceInfo.path);
	if (basename(directory) === "extensions") directory = dirname(directory);
	const directoryName = basename(directory);
	if (directoryName && directoryName !== ".") return directoryName;
	const fileName = basename(tool.sourceInfo.path);
	return fileName.slice(0, Math.max(0, fileName.length - extname(fileName).length)) || "Unknown";
}

export function buildToolCatalog(
	tools: readonly ToolInfo[],
	snapshot: McpToolInventorySnapshotV1 | undefined,
): ToolCatalogItem[] {
	const inventory = inventoryMap(snapshot);
	const items: ToolCatalogItem[] = [];
	for (const tool of tools) {
		const inventoryItem = inventory.get(tool.name);
		if (inventoryItem && !inventoryItem.available) continue;
		if (inventoryItem) {
			const source = inventoryItem.source;
			items.push({
				tool,
				name: tool.name,
				sourceKind: "mcp",
				registrar: "@async23/pi-mcp-control",
				groupKey: `mcp:${source.agentId}:${source.instanceId}`,
				groupLabel: `MCP · ${source.agentLabel} / ${source.serverName}`,
				inventoryItem,
			});
			continue;
		}

		if (tool.sourceInfo.source === "builtin" || tool.sourceInfo.path.startsWith("<builtin:")) {
			items.push({
				tool,
				name: tool.name,
				sourceKind: "builtin",
				registrar: "Pi",
				groupKey: "builtin",
				groupLabel: "Built-in",
			});
			continue;
		}

		if (tool.sourceInfo.source === "sdk" || tool.sourceInfo.path.startsWith("<sdk:")) {
			items.push({
				tool,
				name: tool.name,
				sourceKind: "sdk",
				registrar: "SDK",
				groupKey: "sdk",
				groupLabel: "SDK",
			});
			continue;
		}

		const registrar = extensionLabel(tool);
		items.push({
			tool,
			name: tool.name,
			sourceKind: "extension",
			registrar,
			groupKey: `extension:${tool.sourceInfo.path}`,
			groupLabel: `Extension · ${registrar}`,
		});
	}

	const sourceOrder: Record<ToolSourceKind, number> = { builtin: 0, mcp: 1, extension: 2, sdk: 3 };
	return items.sort(
		(left, right) =>
			sourceOrder[left.sourceKind] - sourceOrder[right.sourceKind] ||
			left.groupLabel.localeCompare(right.groupLabel) ||
			left.name.localeCompare(right.name),
	);
}

export function displaySourcePath(path: string, home: string): string {
	if (path === home) return "~";
	if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
	return path;
}

export class ToolSelectionController {
	readonly #runtime: ToolSelectionRuntime;
	readonly #inventorySnapshot: () => McpToolInventorySnapshotV1 | undefined;
	#inactiveToolNames = new Set<string>();
	#initialInactiveToolNames: Set<string> | undefined;

	constructor(
		runtime: ToolSelectionRuntime,
		inventorySnapshot: () => McpToolInventorySnapshotV1 | undefined = () => undefined,
	) {
		this.#runtime = runtime;
		this.#inventorySnapshot = inventorySnapshot;
	}

	restore(entries: readonly SessionEntry[]): ToolReconciliationResult {
		const savedSelection = latestToolSelectionEntry(entries);
		this.#inactiveToolNames = new Set(
			savedSelection?.inactiveToolNames ?? this.#getInitialInactiveToolNames(),
		);
		return this.reconcile();
	}

	currentSelection(): CurrentToolSelection {
		const items = buildToolCatalog(this.#runtime.getAllTools(), this.#inventorySnapshot());
		const runtimeActiveToolNames = new Set(this.#runtime.getActiveTools());
		const activeToolNames = new Set(items.map((item) => item.name).filter((name) => runtimeActiveToolNames.has(name)));
		return {
			items,
			activeToolNames,
			inactiveToolNames: new Set(items.map((item) => item.name).filter((name) => !activeToolNames.has(name))),
		};
	}

	reconcile(): ToolReconciliationResult {
		const tools = availableTools(this.#runtime.getAllTools(), this.#inventorySnapshot());
		const activeToolNames = tools
			.map((tool) => tool.name)
			.filter((name) => !this.#inactiveToolNames.has(name));
		this.#runtime.setActiveTools(activeToolNames);

		return {
			activeToolNames,
			inactiveToolNames: new Set(this.#inactiveToolNames),
			availableTools: tools,
		};
	}

	applyMcpPreferences(snapshot: McpToolInventorySnapshotV1): string[] {
		const inactiveMcpToolNames = new Set(
			snapshot.tools
				.filter((item) => item.available && this.#inactiveToolNames.has(item.toolName))
				.map((item) => item.toolName),
		);
		const currentActiveToolNames = this.#runtime.getActiveTools();
		const nextActiveToolNames = currentActiveToolNames.filter((name) => !inactiveMcpToolNames.has(name));
		const removedActiveToolNames = currentActiveToolNames.filter((name) => inactiveMcpToolNames.has(name));
		if (removedActiveToolNames.length > 0) this.#runtime.setActiveTools(nextActiveToolNames);
		return removedActiveToolNames;
	}

	apply(nextInactiveToolNames: ReadonlySet<string>): ToolReconciliationResult {
		const tools = availableTools(this.#runtime.getAllTools(), this.#inventorySnapshot());
		const availableNames = new Set(tools.map((tool) => tool.name));
		const next = new Set([
			...[...this.#inactiveToolNames].filter((name) => !availableNames.has(name)),
			...[...nextInactiveToolNames].filter((name) => availableNames.has(name)),
		]);
		const changed = !toolNameSetsEqual(this.#inactiveToolNames, next);
		const activeToolNames = tools.map((tool) => tool.name).filter((name) => !next.has(name));
		this.#runtime.setActiveTools(activeToolNames);
		if (changed) this.#persist(next);
		this.#inactiveToolNames = next;
		return {
			activeToolNames,
			inactiveToolNames: new Set(next),
			availableTools: tools,
		};
	}

	#persist(inactiveToolNames: ReadonlySet<string>): void {
		this.#runtime.appendEntry(TOOL_SELECTION_ENTRY_TYPE, encodeToolSelectionEntry(inactiveToolNames));
	}

	#getInitialInactiveToolNames(): ReadonlySet<string> {
		if (!this.#initialInactiveToolNames) {
			const activeToolNames = new Set(this.#runtime.getActiveTools());
			this.#initialInactiveToolNames = new Set(
				this.#runtime
					.getAllTools()
					.map((tool) => tool.name)
					.filter((name) => !activeToolNames.has(name)),
			);
		}
		return this.#initialInactiveToolNames;
	}
}
