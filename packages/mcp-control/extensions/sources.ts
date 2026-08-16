import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, normalize, parse as parsePath, resolve, sep } from "node:path";
import type { ConfigFileStore } from "./file-store.ts";
import { codecFor } from "./codecs.ts";
import {
	AGENT_SOURCES,
	commandLabel,
	deepMergeRecords,
	displayPath,
	entryIdFor,
	isRecord,
	jsonPointer,
	runtimeInstanceIdFor,
	safeUrl,
	sourceEntryKey,
	sourceIdFor,
	type AgentId,
	type CatalogDiagnostic,
	type ConfigFlavor,
	type ConfigFormat,
	type ConfigSourceDescriptor,
	type ConfigurationLevel,
	type InternalServerEntry,
	type NormalizedServerConfig,
	type ResolutionStrategy,
} from "./model.ts";

export interface SourceDiscoveryOptions {
	cwd: string;
	home?: string;
	projectRoot?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	pathExists?: (path: string) => boolean;
	includeProjectSources?: boolean;
}

export interface InternalCatalog {
	cwd: string;
	projectRoot: string;
	home: string;
	sources: ConfigSourceDescriptor[];
	entries: InternalServerEntry[];
	diagnostics: CatalogDiagnostic[];
}

function ancestorDirectories(root: string, cwd: string): string[] {
	const result: string[] = [];
	let current = normalize(resolve(cwd));
	const boundary = normalize(resolve(root));
	while (true) {
		result.push(current);
		if (current === boundary) break;
		const parent = dirname(current);
		if (parent === current || !current.startsWith(`${boundary}${sep}`)) break;
		current = parent;
	}
	return result.reverse();
}

export function findProjectRoot(cwd: string, pathExists: (path: string) => boolean = existsSync): string {
	let current = normalize(resolve(cwd));
	const filesystemRoot = parsePath(current).root;
	while (true) {
		if (pathExists(join(current, ".git"))) return current;
		if (current === filesystemRoot) return normalize(resolve(cwd));
		current = dirname(current);
	}
}

interface SourceInput {
	agentId: AgentId;
	label: string;
	level: ConfigurationLevel;
	scopeKind: string;
	scopeAnchor: string | null;
	path: string;
	rootPath: string[];
	format: ConfigFormat;
	flavor?: ConfigFlavor;
	precedence: number | null;
	resolutionStrategy: ResolutionStrategy;
	writable?: boolean;
	readOnlyReason?: string;
}

function makeSource(input: SourceInput, home: string, pathExists: (path: string) => boolean): ConfigSourceDescriptor {
	const agentLabel = AGENT_SOURCES.find((agent) => agent.id === input.agentId)?.label ?? input.agentId;
	const absolutePath = normalize(isAbsolute(input.path) ? input.path : resolve(input.path));
	const partial = {
		agentId: input.agentId,
		agentLabel,
		label: input.label,
		level: input.level,
		scopeKind: input.scopeKind,
		scopeAnchor: input.scopeAnchor,
		path: absolutePath,
		rootPath: input.rootPath,
		format: input.format,
		flavor: input.flavor ?? "generic",
		precedence: input.precedence,
		resolutionStrategy: input.resolutionStrategy,
		writable: input.writable ?? true,
		readOnlyReason: input.readOnlyReason,
	};
	return {
		...partial,
		id: sourceIdFor(partial),
		exists: pathExists(absolutePath),
		label: `${input.label} (${displayPath(absolutePath, home)})`,
	};
}

function chooseJsonVariant(
	primary: string,
	alternate: string,
	pathExists: (path: string) => boolean,
): Array<{ path: string; format: ConfigFormat }> {
	const matches = [primary, alternate].filter(pathExists);
	return matches.length > 0
		? matches.map((path) => ({ path, format: "jsonc" as const }))
		: [{ path: primary, format: "jsonc" as const }];
}

export function buildSourceDescriptors(options: SourceDiscoveryOptions): {
	projectRoot: string;
	home: string;
	sources: ConfigSourceDescriptor[];
} {
	const home = normalize(options.home ?? homedir());
	const currentPlatform = options.platform ?? platform();
	const env = options.env ?? process.env;
	const pathExists = options.pathExists ?? existsSync;
	const projectRoot = normalize(options.projectRoot ?? findProjectRoot(options.cwd, pathExists));
	const sources: ConfigSourceDescriptor[] = [];
	const add = (input: SourceInput) => sources.push(makeSource(input, home, pathExists));

	add({
		agentId: "pi",
		label: "Global",
		level: "global",
		scopeKind: "user",
		scopeAnchor: home,
		path: join(home, ".pi", "agent", "mcp.json"),
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: 100,
		resolutionStrategy: "whole-record",
	});
	add({
		agentId: "pi",
		label: "Project",
		level: "project",
		scopeKind: "project",
		scopeAnchor: projectRoot,
		path: join(projectRoot, ".pi", "mcp.json"),
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: 200,
		resolutionStrategy: "whole-record",
	});

	const claudeUserPath = join(home, ".claude.json");
	add({
		agentId: "claude",
		label: "Code user",
		level: "global",
		scopeKind: "user",
		scopeAnchor: home,
		path: claudeUserPath,
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: 100,
		resolutionStrategy: "whole-record",
	});
	add({
		agentId: "claude",
		label: "Code project",
		level: "project",
		scopeKind: "project",
		scopeAnchor: projectRoot,
		path: join(projectRoot, ".mcp.json"),
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: 200,
		resolutionStrategy: "whole-record",
	});
	add({
		agentId: "claude",
		label: "Code local",
		level: "project",
		scopeKind: "local",
		scopeAnchor: projectRoot,
		path: claudeUserPath,
		rootPath: ["projects", projectRoot, "mcpServers"],
		format: "jsonc",
		precedence: 300,
		resolutionStrategy: "whole-record",
	});
	const claudeDesktopPath =
		currentPlatform === "darwin"
			? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
			: join(home, ".config", "Claude", "claude_desktop_config.json");
	add({
		agentId: "claude",
		label: "Desktop local",
		level: "global",
		scopeKind: "desktop",
		scopeAnchor: home,
		path: claudeDesktopPath,
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: null,
		resolutionStrategy: "independent",
	});

	add({
		agentId: "codex",
		label: "User",
		level: "global",
		scopeKind: "user",
		scopeAnchor: home,
		path: join(home, ".codex", "config.toml"),
		rootPath: ["mcp_servers"],
		format: "toml",
		flavor: "codex",
		precedence: 100,
		resolutionStrategy: "deep-merge",
	});
	ancestorDirectories(projectRoot, options.cwd).forEach((directory, index) => {
		add({
			agentId: "codex",
			label: directory === projectRoot ? "Project" : `Project child ${directory.slice(projectRoot.length + 1)}`,
			level: "project",
			scopeKind: "project",
			scopeAnchor: directory,
			path: join(directory, ".codex", "config.toml"),
			rootPath: ["mcp_servers"],
			format: "toml",
			flavor: "codex",
			precedence: 200 + index,
			resolutionStrategy: "deep-merge",
		});
	});

	for (const candidate of chooseJsonVariant(
		join(home, ".config", "opencode", "opencode.json"),
		join(home, ".config", "opencode", "opencode.jsonc"),
		pathExists,
	)) {
		add({
			agentId: "opencode",
			label: "Global",
			level: "global",
			scopeKind: "user",
			scopeAnchor: home,
			path: candidate.path,
			rootPath: ["mcp"],
			format: candidate.format,
			flavor: "opencode",
			precedence: 100,
			resolutionStrategy: "whole-record",
		});
	}
	for (const candidate of chooseJsonVariant(
		join(projectRoot, "opencode.json"),
		join(projectRoot, "opencode.jsonc"),
		pathExists,
	)) {
		add({
			agentId: "opencode",
			label: "Project",
			level: "project",
			scopeKind: "project",
			scopeAnchor: projectRoot,
			path: candidate.path,
			rootPath: ["mcp"],
			format: candidate.format,
			flavor: "opencode",
			precedence: 200,
			resolutionStrategy: "whole-record",
		});
	}

	add({
		agentId: "gemini",
		label: "User",
		level: "global",
		scopeKind: "user",
		scopeAnchor: home,
		path: join(home, ".gemini", "settings.json"),
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: 100,
		resolutionStrategy: "whole-record",
	});
	add({
		agentId: "gemini",
		label: "Project",
		level: "project",
		scopeKind: "project",
		scopeAnchor: projectRoot,
		path: join(projectRoot, ".gemini", "settings.json"),
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: 200,
		resolutionStrategy: "whole-record",
	});

	add({
		agentId: "cursor",
		label: "Global",
		level: "global",
		scopeKind: "user",
		scopeAnchor: home,
		path: join(home, ".cursor", "mcp.json"),
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: null,
		resolutionStrategy: "independent",
	});
	add({
		agentId: "cursor",
		label: "Project",
		level: "project",
		scopeKind: "project",
		scopeAnchor: projectRoot,
		path: join(projectRoot, ".cursor", "mcp.json"),
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: null,
		resolutionStrategy: "independent",
	});

	const kimiHome = normalize(env.KIMI_CODE_HOME ? resolve(env.KIMI_CODE_HOME) : join(home, ".kimi-code"));
	add({
		agentId: "kimi",
		label: "User",
		level: "global",
		scopeKind: "user",
		scopeAnchor: kimiHome,
		path: join(kimiHome, "mcp.json"),
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: 100,
		resolutionStrategy: "whole-record",
	});
	add({
		agentId: "kimi",
		label: "Project",
		level: "project",
		scopeKind: "project",
		scopeAnchor: projectRoot,
		path: join(projectRoot, ".kimi-code", "mcp.json"),
		rootPath: ["mcpServers"],
		format: "jsonc",
		precedence: 200,
		resolutionStrategy: "whole-record",
	});

	const zedUserPath =
		currentPlatform === "darwin" ? join(home, ".zed", "settings.json") : join(home, ".config", "zed", "settings.json");
	for (const [label, level, scopeKind, scopeAnchor, path] of [
		["User", "global", "user", home, zedUserPath],
		["Project", "project", "project", projectRoot, join(projectRoot, ".zed", "settings.json")],
	] as const) {
		add({
			agentId: "zed",
			label,
			level,
			scopeKind,
			scopeAnchor,
			path,
			rootPath: ["context_servers"],
			format: "jsonc",
			flavor: "zed",
			precedence: null,
			resolutionStrategy: "independent",
			writable: false,
			readOnlyReason: "Zed's context_servers shape is discovered read-only until its write schema is pinned.",
		});
	}

	return { projectRoot, home, sources };
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function normalizeServerConfig(config: Record<string, unknown>, flavor: ConfigFlavor): NormalizedServerConfig {
	const nestedCommand = isRecord(config.command) ? config.command : undefined;
	const openCodeCommand = flavor === "opencode" ? stringArray(config.command) : [];
	const command =
		(typeof config.command === "string" ? config.command : undefined) ??
		(typeof nestedCommand?.path === "string" ? nestedCommand.path : undefined) ??
		openCodeCommand[0];
	const args =
		openCodeCommand.length > 0
			? openCodeCommand.slice(1)
			: stringArray(config.args).length > 0
				? stringArray(config.args)
				: stringArray(nestedCommand?.args);
	const rawUrl = [config.url, config.httpUrl, config.serverUrl].find((value): value is string => typeof value === "string");
	const type = typeof config.type === "string" ? config.type.toLowerCase() : "";
	const transportValue = typeof config.transport === "string" ? config.transport.toLowerCase() : "";
	const transport = rawUrl
		? type === "sse" || transportValue === "sse"
			? "sse"
			: "http"
		: command
			? "stdio"
			: "unknown";
	const environment = {
		...stringRecord(nestedCommand?.env),
		...stringRecord(config.environment),
		...stringRecord(config.env),
	};
	const headers = {
		...stringRecord(config.http_headers),
		...stringRecord(config.headers),
	};
	return {
		transport,
		command: commandLabel(command),
		argumentCount: args.length,
		url: rawUrl ? safeUrl(rawUrl) : undefined,
		enabled: config.enabled !== false && config.disabled !== true,
		environmentNames: Object.keys(environment).sort(),
		headerNames: Object.keys(headers).sort(),
	};
}

function applyResolution(entries: InternalServerEntry[]): void {
	const grouped = new Map<string, InternalServerEntry[]>();
	for (const entry of entries) {
		if (entry.source.resolutionStrategy === "independent") {
			entry.resolution = entry.normalized.enabled ? "unknown-precedence" : "disabled";
			entry.originChain = [entry.id];
			entry.effectiveConfig = entry.rawConfig;
			entry.runtimeInstanceId = runtimeInstanceIdFor(entry.agentId, entry.serverName, entry.originChain);
			continue;
		}
		const key = `${entry.agentId}\u0000${entry.serverName}\u0000${entry.source.resolutionStrategy}`;
		const group = grouped.get(key) ?? [];
		group.push(entry);
		grouped.set(key, group);
	}

	for (const group of grouped.values()) {
		group.sort((left, right) => {
			const precedence = (left.source.precedence ?? 0) - (right.source.precedence ?? 0);
			return precedence !== 0 ? precedence : left.source.path.localeCompare(right.source.path);
		});
		const winner = group.at(-1);
		if (!winner) continue;
		const originChain = group.map((entry) => entry.id);
		if (winner.source.resolutionStrategy === "deep-merge") {
			const effective = group.reduce(
				(result, entry) => deepMergeRecords(result, entry.rawConfig),
				{} as Record<string, unknown>,
			);
			for (const entry of group) {
				entry.resolution = entry === winner ? (normalizeServerConfig(effective, "codex").enabled ? "active" : "disabled") : "contributes";
				entry.originChain = originChain;
			}
			winner.effectiveConfig = effective;
			winner.runtimeInstanceId = runtimeInstanceIdFor(winner.agentId, winner.serverName, originChain);
			continue;
		}

		for (const entry of group) {
			entry.resolution = entry === winner ? (entry.normalized.enabled ? "active" : "disabled") : "shadowed";
			entry.originChain = originChain;
		}
		winner.effectiveConfig = winner.rawConfig;
		winner.runtimeInstanceId = runtimeInstanceIdFor(winner.agentId, winner.serverName, originChain);
	}
}

export function discoverCatalog(
	fileStore: ConfigFileStore,
	options: SourceDiscoveryOptions,
): InternalCatalog {
	const { projectRoot, home, sources } = buildSourceDescriptors(options);
	const entries: InternalServerEntry[] = [];
	const diagnostics: CatalogDiagnostic[] = [];

	for (const source of sources) {
		if (source.level === "project" && options.includeProjectSources === false) {
			source.writable = false;
			source.readOnlyReason = "Project MCP configuration is unavailable until this project is trusted.";
			continue;
		}
		const file = fileStore.read(source.path);
		source.exists = file.exists;
		if (!file.exists) continue;
		try {
			const document = codecFor(source.format).parseDocument(file.content, source.rootPath);
			for (const [serverName, value] of Object.entries(document.serverMap)) {
				if (!isRecord(value)) {
					diagnostics.push({
						severity: "warning",
						agentId: source.agentId,
						sourceId: source.id,
						path: source.path,
						message: `Ignored non-object MCP server entry '${serverName}'.`,
					});
					continue;
				}
				const key = sourceEntryKey(source, serverName);
				entries.push({
					id: entryIdFor(key),
					key,
					sourceId: source.id,
					agentId: source.agentId,
					agentLabel: source.agentLabel,
					serverName,
					source,
					rawConfig: structuredClone(value),
					sourceText: document.sourceTextByServer[serverName] ?? "",
					normalized: normalizeServerConfig(value, source.flavor),
					resolution: "unknown-precedence",
					originChain: [],
				});
			}
		} catch (error) {
			diagnostics.push({
				severity: "error",
				agentId: source.agentId,
				sourceId: source.id,
				path: source.path,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	applyResolution(entries);
	return { cwd: normalize(resolve(options.cwd)), projectRoot, home, sources, entries, diagnostics };
}

export function entryPointer(source: ConfigSourceDescriptor, serverName: string): string {
	return jsonPointer([...source.rootPath, serverName]);
}
