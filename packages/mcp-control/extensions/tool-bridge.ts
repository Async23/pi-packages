import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import { adaptResourceResult, adaptToolResult } from "./content.ts";
import { canonicalJson, isRecord, safeUrl, stableId, type RuntimeServerDefinition } from "./model.ts";
import {
	allowConnectedInvocationPolicy,
	type McpInvocationPolicy,
} from "./policy.ts";
import { McpRuntimeManager, type RuntimePrimitiveCatalog } from "./runtime.ts";

export const MCP_TOOL_INVENTORY_PROTOCOL = "@async23/pi-mcp-control/tool-inventory";
export const MCP_TOOL_INVENTORY_VERSION = 1;
export const MCP_TOOL_INVENTORY_REQUEST_CHANNEL = `${MCP_TOOL_INVENTORY_PROTOCOL}/v1/request`;
export const MCP_TOOL_INVENTORY_SNAPSHOT_CHANNEL = `${MCP_TOOL_INVENTORY_PROTOCOL}/v1/snapshot`;

export interface McpToolInventorySourceV1 {
	instanceId: string;
	agentId: string;
	agentLabel: string;
	serverName: string;
	primitiveKind: "tool" | "resource";
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

interface ToolNameClaim {
	name: string;
	identity: string;
}

const MAX_PI_TOOL_NAME_LENGTH = 64;
const TOOL_NAME_SUFFIX_LENGTH = 8;
const TOOL_NAME_SEPARATOR = "__";

function identifierPart(value: string, maxLength: number): string {
	const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
	const shortened = normalized.slice(0, maxLength).replace(/_+$/g, "");
	return shortened || "unnamed";
}

function compactToolName(readableName: string, identityKind: string, identity: unknown): string {
	const suffix = stableId(identityKind, identity).split(":").at(-1)?.slice(0, TOOL_NAME_SUFFIX_LENGTH) ?? "unknown";
	const maxReadableLength = MAX_PI_TOOL_NAME_LENGTH - TOOL_NAME_SEPARATOR.length - suffix.length;
	return `${identifierPart(readableName, maxReadableLength)}${TOOL_NAME_SEPARATOR}${suffix}`;
}

export function piToolName(definition: RuntimeServerDefinition, remoteToolName: string): string {
	return compactToolName(remoteToolName, "tool", { instanceId: definition.instanceId, remoteToolName });
}

function resourceToolName(definition: RuntimeServerDefinition): string {
	return compactToolName("read_resource", "resource-tool", definition.instanceId);
}

function toolSchema(tool: Tool): ReturnType<typeof Type.Unsafe> {
	const schema = isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", additionalProperties: true };
	return Type.Unsafe<Record<string, unknown>>(schema as never);
}

function conciseDescription(value: string | undefined, fallback: string): string {
	const text = value?.trim() || fallback;
	return text.length <= 1200 ? text : `${text.slice(0, 1197)}…`;
}

function safeResourceUri(uri: string): string {
	if (/^https?:\/\//i.test(uri)) return safeUrl(uri);
	try {
		const parsed = new URL(uri);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString().slice(0, 300);
	} catch {
		return uri.split(/[?#]/, 1)[0]?.slice(0, 300) || "<redacted-resource-uri>";
	}
}

interface InstanceRegistration {
	definition: RuntimeServerDefinition;
	toolNames: Set<string>;
	fingerprints: Map<string, string>;
	inventory: Map<string, McpToolInventoryItemV1>;
}

export class PiToolBridge {
	readonly #pi: ExtensionAPI;
	readonly #runtime: McpRuntimeManager;
	readonly #invocationPolicy: McpInvocationPolicy;
	readonly #instances = new Map<string, InstanceRegistration>();
	readonly #allManagedNames = new Set<string>();
	readonly #nameOwners = new Map<string, string>();
	readonly #unsubscribe: () => void;
	readonly #unsubscribeInventoryRequest: () => void;
	#inventoryGeneration = 0;

	constructor(
		pi: ExtensionAPI,
		runtime: McpRuntimeManager,
		invocationPolicy: McpInvocationPolicy = allowConnectedInvocationPolicy,
	) {
		this.#pi = pi;
		this.#runtime = runtime;
		this.#invocationPolicy = invocationPolicy;
		this.#unsubscribe = runtime.subscribe((instanceId, snapshot, catalog) => {
			if (snapshot.state === "ready") this.#registerCatalog(instanceId, catalog);
			else this.#deactivateInstance(instanceId);
		});
		this.#unsubscribeInventoryRequest = pi.events?.on?.(MCP_TOOL_INVENTORY_REQUEST_CHANNEL, (data) => {
			if (!isRecord(data) || data.protocol !== MCP_TOOL_INVENTORY_PROTOCOL || data.version !== MCP_TOOL_INVENTORY_VERSION) return;
			this.#publishInventorySnapshot();
		}) ?? (() => undefined);
		this.#publishInventorySnapshot();
	}

	track(definition: RuntimeServerDefinition): void {
		const current = this.#instances.get(definition.instanceId);
		if (current) current.definition = definition;
		else {
			this.#instances.set(definition.instanceId, {
				definition,
				toolNames: new Set(),
				fingerprints: new Map(),
				inventory: new Map(),
			});
		}
	}

	inventorySnapshot(): McpToolInventorySnapshotV1 {
		return {
			protocol: MCP_TOOL_INVENTORY_PROTOCOL,
			version: MCP_TOOL_INVENTORY_VERSION,
			generation: this.#inventoryGeneration,
			tools: [...this.#instances.values()]
				.flatMap((registration) => [...registration.inventory.values()])
				.sort((left, right) => left.toolName.localeCompare(right.toolName))
				.map((item) => ({ ...item, source: { ...item.source } })),
		};
	}

	#publishInventorySnapshot(): void {
		this.#inventoryGeneration += 1;
		this.#pi.events?.emit?.(MCP_TOOL_INVENTORY_SNAPSHOT_CHANNEL, this.inventorySnapshot());
	}

	#inventoryItem(
		registration: InstanceRegistration,
		toolName: string,
		primitiveKind: McpToolInventorySourceV1["primitiveKind"],
		remoteName: string,
	): McpToolInventoryItemV1 {
		return {
			toolName,
			available: true,
			source: {
				instanceId: registration.definition.instanceId,
				agentId: registration.definition.agentId,
				agentLabel: registration.definition.agentLabel,
				serverName: registration.definition.serverName,
				primitiveKind,
				remoteName,
			},
		};
	}

	#claimNames(claims: readonly ToolNameClaim[]): void {
		const registeredNames = new Set(this.#pi.getAllTools?.().map((tool) => tool.name) ?? []);
		const stagedOwners = new Map(this.#nameOwners);
		for (const claim of claims) {
			const owner = stagedOwners.get(claim.name);
			if (owner && owner !== claim.identity) {
				throw new Error(`MCP Tool Name collision: '${claim.name}' maps to multiple MCP primitives.`);
			}
			if (!owner && registeredNames.has(claim.name)) {
				throw new Error(`MCP Tool Name collision: '${claim.name}' is already registered outside mcp-control.`);
			}
			stagedOwners.set(claim.name, claim.identity);
		}
		for (const claim of claims) this.#nameOwners.set(claim.name, claim.identity);
	}

	#registerCatalog(instanceId: string, catalog: RuntimePrimitiveCatalog): void {
		const registration = this.#instances.get(instanceId);
		if (!registration) return;
		const claims: ToolNameClaim[] = catalog.tools.map((remoteTool) => ({
			name: piToolName(registration.definition, remoteTool.name),
			identity: canonicalJson({ kind: "tool", instanceId, remoteName: remoteTool.name }),
		}));
		if (catalog.resources.length > 0 || catalog.resourceTemplates.length > 0) {
			claims.push({
				name: resourceToolName(registration.definition),
				identity: canonicalJson({ kind: "resource", instanceId }),
			});
		}
		this.#claimNames(claims);
		const nextNames = new Set<string>();
		for (const item of registration.inventory.values()) item.available = false;

		for (const remoteTool of catalog.tools) {
			const name = piToolName(registration.definition, remoteTool.name);
			nextNames.add(name);
			this.#allManagedNames.add(name);
			registration.inventory.set(name, this.#inventoryItem(registration, name, "tool", remoteTool.name));
			const fingerprint = canonicalJson(remoteTool);
			if (registration.fingerprints.get(name) === fingerprint) continue;
			registration.fingerprints.set(name, fingerprint);
			this.#pi.registerTool({
				name,
				label: `${registration.definition.serverName} · ${remoteTool.name}`,
				description: conciseDescription(
					remoteTool.description,
					`Call MCP tool '${remoteTool.name}' from ${registration.definition.agentLabel} / ${registration.definition.serverName}.`,
				),
				parameters: toolSchema(remoteTool),
				executionMode: "parallel",
				execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
					const arguments_ = params as Record<string, unknown>;
					const decision = await this.#invocationPolicy.authorize(
						{ kind: "tool", definition: registration.definition, tool: remoteTool, arguments: arguments_ },
						ctx,
					);
					if (!decision.allowed) throw new Error(decision.reason ?? "MCP invocation policy denied this tool call.");
					const result = await this.#runtime.callTool(
						instanceId,
						remoteTool.name,
						arguments_,
						signal,
					);
					return adaptToolResult(result);
				},
			});
		}

		if (catalog.resources.length > 0 || catalog.resourceTemplates.length > 0) {
			const name = resourceToolName(registration.definition);
			nextNames.add(name);
			this.#allManagedNames.add(name);
			registration.inventory.set(name, this.#inventoryItem(registration, name, "resource", "read-resource"));
			const fingerprint = canonicalJson({ resources: catalog.resources, templates: catalog.resourceTemplates });
			if (registration.fingerprints.get(name) !== fingerprint) {
				registration.fingerprints.set(name, fingerprint);
				const examples = catalog.resources.slice(0, 8).map((resource) => safeResourceUri(resource.uri));
				this.#pi.registerTool({
					name,
					label: `${registration.definition.serverName} · Read resource`,
					description: conciseDescription(
						`Read a resource from ${registration.definition.agentLabel} / ${registration.definition.serverName}. Known resource URIs: ${examples.join(", ") || "use a URI matching a listed template"}.`,
						"Read an MCP resource.",
					),
					parameters: Type.Object({ uri: Type.String({ description: "Exact MCP resource URI" }) }),
					executionMode: "parallel",
					execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
						const decision = await this.#invocationPolicy.authorize(
							{ kind: "resource", definition: registration.definition, uri: params.uri },
							ctx,
						);
						if (!decision.allowed) throw new Error(decision.reason ?? "MCP invocation policy denied this resource read.");
						const result = await this.#runtime.readResource(instanceId, params.uri, signal);
						return adaptResourceResult(result);
					},
				});
			}
		}

		registration.toolNames = nextNames;
		this.#reconcileActiveTools();
		this.#publishInventorySnapshot();
	}

	#deactivateInstance(instanceId: string): void {
		const registration = this.#instances.get(instanceId);
		if (!registration) return;
		const hadAvailableTool = [...registration.inventory.values()].some((item) => item.available);
		if (registration.toolNames.size === 0 && !hadAvailableTool) return;
		for (const item of registration.inventory.values()) item.available = false;
		registration.toolNames.clear();
		this.#reconcileActiveTools();
		this.#publishInventorySnapshot();
	}

	#reconcileActiveTools(): void {
		const desired = new Set<string>();
		for (const registration of this.#instances.values()) {
			for (const name of registration.toolNames) desired.add(name);
		}
		const next = this.#pi.getActiveTools().filter((name) => !this.#allManagedNames.has(name) || desired.has(name));
		for (const name of desired) {
			if (!next.includes(name)) next.push(name);
		}
		this.#pi.setActiveTools(next);
	}

	dispose(): void {
		this.#unsubscribe();
		this.#unsubscribeInventoryRequest();
		for (const registration of this.#instances.values()) registration.toolNames.clear();
		this.#reconcileActiveTools();
	}
}
