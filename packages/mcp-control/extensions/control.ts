import { homedir } from "node:os";
import { NodeConfigFileStore, type ConfigFileStore } from "./file-store.ts";
import {
	AGENT_SOURCES,
	cloneRecord,
	errorMessage,
	redactConfig,
	type AgentSummary,
	type ChangePlanSummary,
	type InternalServerEntry,
	type McpControlCommand,
	type McpControlCommandResult,
	type McpControlSnapshot,
	type McpServerEntry,
	type RuntimeServerDefinition,
} from "./model.ts";
import { ConfigMutationCoordinator } from "./mutation.ts";
import { explicitActivationPolicy, type McpActivationPolicy } from "./policy.ts";
import { McpRuntimeManager } from "./runtime.ts";
import { discoverCatalog, type InternalCatalog, type SourceDiscoveryOptions } from "./sources.ts";

export interface McpControlOptions {
	cwd?: string;
	home?: string;
	projectRoot?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	pathExists?: (path: string) => boolean;
	includeProjectSources?: boolean;
	fileStore?: ConfigFileStore;
	runtime?: McpRuntimeManager;
	onWillConnect?: (definition: RuntimeServerDefinition) => void;
	activationPolicy?: McpActivationPolicy;
}

export type McpControlListener = (snapshot: McpControlSnapshot) => void;

const AGENT_NOTES: Partial<Record<(typeof AGENT_SOURCES)[number]["id"], string>> = {
	agents: "No verified .agents MCP config format; the tab remains visible and empty.",
	antigravity: "No verified local Antigravity MCP config source yet.",
	trae: "No verified local Trae MCP config source yet.",
	grok: "No verified local Grok MCP config source yet.",
	zed: "Zed context_servers are discovered read-only until its write schema is pinned.",
};

export class McpControl {
	readonly #fileStore: ConfigFileStore;
	readonly #runtime: McpRuntimeManager;
	readonly #mutations: ConfigMutationCoordinator;
	readonly #listeners = new Set<McpControlListener>();
	readonly #baseOptions: Omit<SourceDiscoveryOptions, "cwd">;
	readonly #onWillConnect?: (definition: RuntimeServerDefinition) => void;
	readonly #activationPolicy: McpActivationPolicy;
	readonly #planSummaries = new Map<string, ChangePlanSummary>();
	#catalog: InternalCatalog;
	#revision = 1;
	#includeProjectSources: boolean;

	constructor(options: McpControlOptions = {}) {
		this.#fileStore = options.fileStore ?? new NodeConfigFileStore();
		this.#runtime = options.runtime ?? new McpRuntimeManager();
		this.#mutations = new ConfigMutationCoordinator(this.#fileStore);
		this.#onWillConnect = options.onWillConnect;
		this.#activationPolicy = options.activationPolicy ?? explicitActivationPolicy;
		this.#includeProjectSources = options.includeProjectSources ?? true;
		this.#baseOptions = {
			home: options.home ?? homedir(),
			projectRoot: options.projectRoot,
			platform: options.platform,
			env: options.env,
			pathExists: options.pathExists,
		};
		this.#catalog = discoverCatalog(this.#fileStore, {
			...this.#baseOptions,
			cwd: options.cwd ?? process.cwd(),
			includeProjectSources: this.#includeProjectSources,
		});
		this.#runtime.subscribe(() => {
			this.#revision += 1;
			this.#emit();
		});
	}

	snapshot(): McpControlSnapshot {
		const entries: McpServerEntry[] = this.#catalog.entries.map((entry) => {
			const runtime = entry.runtimeInstanceId
				? this.#runtime.snapshot(entry.runtimeInstanceId)
				: undefined;
			return {
				id: entry.id,
				sourceId: entry.sourceId,
				agentId: entry.agentId,
				agentLabel: entry.agentLabel,
				serverName: entry.serverName,
				sourceLabel: entry.source.label,
				level: entry.source.level,
				path: entry.source.path,
				entryPointer: entry.key.entryPointer,
				writable: entry.source.writable,
				readOnlyReason: entry.source.readOnlyReason,
				normalized: { ...entry.normalized },
				config: redactConfig(entry.rawConfig),
				resolution: entry.resolution,
				originChain: [...entry.originChain],
				runtimeInstanceId: entry.runtimeInstanceId,
				runtimeState: runtime?.state ?? "disconnected",
				runtimeError: runtime?.error,
				primitiveCounts: runtime
					? {
							tools: runtime.toolCount,
							resources: runtime.resourceCount,
							resourceTemplates: runtime.resourceTemplateCount,
							prompts: runtime.promptCount,
						}
					: undefined,
			};
		});

		const agents: AgentSummary[] = AGENT_SOURCES.map((agent) => ({
			...agent,
			count: entries.filter((entry) => entry.agentId === agent.id).length,
			writableSourceCount: this.#catalog.sources.filter((source) => source.agentId === agent.id && source.writable).length,
			note: AGENT_NOTES[agent.id],
		}));

		return {
			revision: this.#revision,
			cwd: this.#catalog.cwd,
			projectRoot: this.#catalog.projectRoot,
			agents,
			sources: this.#catalog.sources.map((source) => ({ ...source, rootPath: [...source.rootPath] })),
			entries,
			diagnostics: this.#catalog.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		};
	}

	subscribe(listener: McpControlListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.#listeners) listener(snapshot);
	}

	#refresh(cwd = this.#catalog.cwd, includeProjectSources = this.#includeProjectSources): McpControlSnapshot {
		this.#includeProjectSources = includeProjectSources;
		this.#catalog = discoverCatalog(this.#fileStore, {
			...this.#baseOptions,
			cwd,
			includeProjectSources,
		});
		this.#revision += 1;
		const snapshot = this.snapshot();
		for (const listener of this.#listeners) listener(snapshot);
		return snapshot;
	}

	#entry(entryId: string): InternalServerEntry {
		const entry = this.#catalog.entries.find((candidate) => candidate.id === entryId);
		if (!entry) throw new Error(`Unknown MCP server entry: ${entryId}`);
		return entry;
	}

	#definition(entry: InternalServerEntry): RuntimeServerDefinition {
		const decision = this.#activationPolicy.canConnect(entry);
		if (!decision.allowed) throw new Error(decision.reason ?? "MCP activation policy denied this connection.");
		if (!entry.runtimeInstanceId || !entry.effectiveConfig) throw new Error("MCP entry has no runtime instance.");
		return {
			instanceId: entry.runtimeInstanceId,
			entryId: entry.id,
			agentId: entry.agentId,
			agentLabel: entry.agentLabel,
			serverName: entry.serverName,
			config: cloneRecord(entry.effectiveConfig),
			flavor: entry.source.flavor,
			cwd: this.#catalog.cwd,
		};
	}

	async execute(command: McpControlCommand): Promise<McpControlCommandResult> {
		switch (command.type) {
			case "refresh":
				return {
					type: "snapshot",
					snapshot: this.#refresh(command.cwd, command.includeProjectSources ?? this.#includeProjectSources),
				};
			case "plan-upsert": {
				const plan = this.#mutations.planUpsert(
					this.#catalog,
					command.sourceId,
					command.serverName,
					command.config,
				);
				this.#planSummaries.set(plan.id, plan);
				return { type: "plan", plan };
			}
			case "plan-patch": {
				const plan = this.#mutations.planPatch(this.#catalog, command.entryId, command.patch, command.unset);
				this.#planSummaries.set(plan.id, plan);
				return { type: "plan", plan };
			}
			case "plan-delete": {
				const plan = this.#mutations.planDelete(this.#catalog, command.entryId);
				this.#planSummaries.set(plan.id, plan);
				return { type: "plan", plan };
			}
			case "discard-plan":
				this.#mutations.discard(command.planId);
				this.#planSummaries.delete(command.planId);
				return { type: "discarded", planId: command.planId };
			case "commit": {
				const summary = this.#planSummaries.get(command.planId);
				if (!summary) throw new Error(`Unknown or expired MCP change plan: ${command.planId}`);
				const affected = this.#catalog.entries.filter(
					(entry) => entry.agentId === summary.agentId && entry.serverName === summary.serverName,
				);
				const result = this.#mutations.commit(command.planId);
				this.#planSummaries.delete(command.planId);
				await Promise.allSettled(
					affected
						.map((entry) => entry.runtimeInstanceId)
						.filter((instanceId): instanceId is string => Boolean(instanceId))
						.map((instanceId) => this.#runtime.disconnect(instanceId)),
				);
				return { type: "committed", result, snapshot: this.#refresh() };
			}
			case "connect": {
				const entry = this.#entry(command.entryId);
				const definition = this.#definition(entry);
				this.#onWillConnect?.(definition);
				const runtime = await this.#runtime.connect(definition);
				return { type: "runtime", entryId: entry.id, state: runtime.state, snapshot: this.snapshot() };
			}
			case "disconnect": {
				const entry = this.#entry(command.entryId);
				if (!entry.runtimeInstanceId) throw new Error("MCP entry has no runtime instance.");
				const runtime = await this.#runtime.disconnect(entry.runtimeInstanceId);
				return { type: "runtime", entryId: entry.id, state: runtime.state, snapshot: this.snapshot() };
			}
			case "disconnect-all":
				await this.#runtime.disconnectAll();
				return { type: "runtime", state: "disconnected", snapshot: this.snapshot() };
			default: {
				const neverCommand: never = command;
				throw new Error(`Unsupported MCP control command: ${errorMessage(neverCommand)}`);
			}
		}
	}
}
