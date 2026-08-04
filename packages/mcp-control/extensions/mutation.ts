import { randomUUID } from "node:crypto";
import { codecFor, serverDiff } from "./codecs.ts";
import type { ConfigFileStore } from "./file-store.ts";
import {
	cloneRecord,
	type ChangePlanSummary,
	type CommitResult,
	type ConfigSourceDescriptor,
	type InternalServerEntry,
} from "./model.ts";
import type { InternalCatalog } from "./sources.ts";

export class UnknownMcpSourceError extends Error {
	constructor(id: string) {
		super(`Unknown MCP configuration source: ${id}`);
		this.name = "UnknownMcpSourceError";
	}
}

export class UnknownMcpEntryError extends Error {
	constructor(id: string) {
		super(`Unknown MCP server entry: ${id}`);
		this.name = "UnknownMcpEntryError";
	}
}

export class ReadOnlyMcpSourceError extends Error {
	constructor(source: ConfigSourceDescriptor) {
		super(source.readOnlyReason ?? `MCP source is read-only: ${source.path}`);
		this.name = "ReadOnlyMcpSourceError";
	}
}

export class InvalidServerNameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidServerNameError";
	}
}

export class NoConfigChangeError extends Error {
	constructor() {
		super("The requested MCP configuration is already present.");
		this.name = "NoConfigChangeError";
	}
}

interface InternalChangePlan {
	summary: ChangePlanSummary;
	content: string;
}

function validateServerName(serverName: string): string {
	const trimmed = serverName.trim();
	if (trimmed.length === 0) throw new InvalidServerNameError("MCP server name cannot be empty.");
	if (trimmed.length > 256) throw new InvalidServerNameError("MCP server name cannot exceed 256 characters.");
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
		throw new InvalidServerNameError("MCP server name cannot contain control characters.");
	}
	return trimmed;
}

export class ConfigMutationCoordinator {
	readonly #fileStore: ConfigFileStore;
	readonly #plans = new Map<string, InternalChangePlan>();

	constructor(fileStore: ConfigFileStore) {
		this.#fileStore = fileStore;
	}

	planUpsert(
		catalog: InternalCatalog,
		sourceId: string,
		serverNameInput: string,
		config: Record<string, unknown>,
	): ChangePlanSummary {
		const source = catalog.sources.find((candidate) => candidate.id === sourceId);
		if (!source) throw new UnknownMcpSourceError(sourceId);
		if (!source.writable) throw new ReadOnlyMcpSourceError(source);
		const serverName = validateServerName(serverNameInput);
		const existing = catalog.entries.find(
			(entry) => entry.sourceId === source.id && entry.serverName === serverName,
		);
		return this.#plan(source, serverName, existing, cloneRecord(config));
	}

	planDelete(catalog: InternalCatalog, entryId: string): ChangePlanSummary {
		const entry = catalog.entries.find((candidate) => candidate.id === entryId);
		if (!entry) throw new UnknownMcpEntryError(entryId);
		if (!entry.source.writable) throw new ReadOnlyMcpSourceError(entry.source);
		return this.#plan(entry.source, entry.serverName, entry, undefined);
	}

	planPatch(
		catalog: InternalCatalog,
		entryId: string,
		patch: Record<string, unknown>,
		unset: readonly string[] = [],
	): ChangePlanSummary {
		const entry = catalog.entries.find((candidate) => candidate.id === entryId);
		if (!entry) throw new UnknownMcpEntryError(entryId);
		if (!entry.source.writable) throw new ReadOnlyMcpSourceError(entry.source);
		const next = cloneRecord(entry.rawConfig);
		for (const key of unset) delete next[key];
		for (const [key, value] of Object.entries(patch)) next[key] = structuredClone(value);
		return this.#plan(entry.source, entry.serverName, entry, next);
	}

	#plan(
		source: ConfigSourceDescriptor,
		serverName: string,
		existing: InternalServerEntry | undefined,
		nextConfig: Record<string, unknown> | undefined,
	): ChangePlanSummary {
		const file = this.#fileStore.read(source.path);
		const codec = codecFor(source.format);
		codec.parseDocument(file.content, source.rootPath);
		const content = nextConfig
			? codec.upsertServer(file.content, source.rootPath, serverName, nextConfig)
			: codec.deleteServer(file.content, source.rootPath, serverName);
		if (content === file.content) throw new NoConfigChangeError();

		const operation = nextConfig ? (existing ? "update" : "add") : "delete";
		const id = randomUUID();
		const summary: ChangePlanSummary = {
			id,
			operation,
			agentId: source.agentId,
			serverName,
			path: source.path,
			sourceId: source.id,
			diff: serverDiff(existing?.rawConfig, nextConfig),
			expectedHash: file.hash,
			createsFile: !file.exists,
		};
		this.#plans.set(id, { summary, content });
		return summary;
	}

	commit(planId: string): CommitResult {
		const plan = this.#plans.get(planId);
		if (!plan) throw new Error(`Unknown or expired MCP change plan: ${planId}`);
		const result = this.#fileStore.writeAtomic({
			path: plan.summary.path,
			content: plan.content,
			expectedHash: plan.summary.expectedHash,
		});
		this.#plans.delete(planId);
		return {
			planId,
			path: result.path,
			backupPath: result.backupPath,
			created: result.created,
		};
	}

	discard(planId: string): void {
		this.#plans.delete(planId);
	}

	has(planId: string): boolean {
		return this.#plans.has(planId);
	}
}
