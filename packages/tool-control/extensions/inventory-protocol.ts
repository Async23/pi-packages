export const MCP_TOOL_INVENTORY_PROTOCOL = "@async23/pi-mcp-control/tool-inventory";
export const MCP_TOOL_INVENTORY_VERSION = 1;
export const MCP_TOOL_INVENTORY_REQUEST_CHANNEL = `${MCP_TOOL_INVENTORY_PROTOCOL}/v1/request`;
export const MCP_TOOL_INVENTORY_SNAPSHOT_CHANNEL = `${MCP_TOOL_INVENTORY_PROTOCOL}/v1/snapshot`;

export type McpPrimitiveKind = "tool" | "resource";

export interface McpToolInventorySourceV1 {
	instanceId: string;
	agentId: string;
	agentLabel: string;
	serverName: string;
	primitiveKind: McpPrimitiveKind;
	remoteName: string;
}

export interface McpToolInventoryItemV1 {
	toolName: string;
	available: boolean;
	source: McpToolInventorySourceV1;
}

export interface McpToolInventorySnapshotV1 {
	protocol: typeof MCP_TOOL_INVENTORY_PROTOCOL;
	version: typeof MCP_TOOL_INVENTORY_VERSION;
	generation: number;
	tools: McpToolInventoryItemV1[];
}

export interface ToolInventoryEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSource(value: unknown): McpToolInventorySourceV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.instanceId !== "string" ||
		typeof value.agentId !== "string" ||
		typeof value.agentLabel !== "string" ||
		typeof value.serverName !== "string" ||
		(value.primitiveKind !== "tool" && value.primitiveKind !== "resource") ||
		typeof value.remoteName !== "string"
	) {
		return undefined;
	}
	return {
		instanceId: value.instanceId,
		agentId: value.agentId,
		agentLabel: value.agentLabel,
		serverName: value.serverName,
		primitiveKind: value.primitiveKind,
		remoteName: value.remoteName,
	};
}

function parseInventoryItem(value: unknown): McpToolInventoryItemV1 | undefined {
	if (!isRecord(value) || typeof value.toolName !== "string" || value.toolName.length === 0 || typeof value.available !== "boolean") {
		return undefined;
	}
	const source = parseSource(value.source);
	if (!source) return undefined;
	return { toolName: value.toolName, available: value.available, source };
}

export function parseMcpToolInventorySnapshot(value: unknown): McpToolInventorySnapshotV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.protocol !== MCP_TOOL_INVENTORY_PROTOCOL ||
		value.version !== MCP_TOOL_INVENTORY_VERSION ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 0 ||
		!Array.isArray(value.tools)
	) {
		return undefined;
	}
	const tools: McpToolInventoryItemV1[] = [];
	const seenNames = new Set<string>();
	for (const candidate of value.tools) {
		const item = parseInventoryItem(candidate);
		if (!item || seenNames.has(item.toolName)) return undefined;
		seenNames.add(item.toolName);
		tools.push(item);
	}
	return {
		protocol: MCP_TOOL_INVENTORY_PROTOCOL,
		version: MCP_TOOL_INVENTORY_VERSION,
		generation: value.generation,
		tools,
	};
}

export class McpToolInventoryClient {
	readonly #events: ToolInventoryEventBus;
	readonly #unsubscribe: () => void;
	readonly #onSnapshot?: (snapshot: McpToolInventorySnapshotV1) => void;
	#snapshot: McpToolInventorySnapshotV1 | undefined;

	constructor(events: ToolInventoryEventBus, onSnapshot?: (snapshot: McpToolInventorySnapshotV1) => void) {
		this.#events = events;
		this.#onSnapshot = onSnapshot;
		this.#unsubscribe = events.on(MCP_TOOL_INVENTORY_SNAPSHOT_CHANNEL, (data) => {
			const snapshot = parseMcpToolInventorySnapshot(data);
			if (!snapshot) return;
			this.#snapshot = snapshot;
			this.#onSnapshot?.(snapshot);
		});
		this.request();
	}

	request(): void {
		this.#events.emit(MCP_TOOL_INVENTORY_REQUEST_CHANNEL, {
			protocol: MCP_TOOL_INVENTORY_PROTOCOL,
			version: MCP_TOOL_INVENTORY_VERSION,
		});
	}

	snapshot(): McpToolInventorySnapshotV1 | undefined {
		return this.#snapshot;
	}

	dispose(): void {
		this.#unsubscribe();
	}
}
