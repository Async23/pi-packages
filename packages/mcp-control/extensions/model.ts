import { createHash } from "node:crypto";
import { basename, normalize, resolve, sep } from "node:path";

export const AGENT_SOURCES = [
	{ id: "agents", label: ".agents", shortLabel: ".agents", support: "unverified" },
	{ id: "pi", label: "Pi", shortLabel: "Pi", support: "supported" },
	{ id: "claude", label: "Claude", shortLabel: "Claude", support: "supported" },
	{ id: "codex", label: "Codex", shortLabel: "Codex", support: "supported" },
	{ id: "opencode", label: "OpenCode", shortLabel: "OpenCode", support: "supported" },
	{ id: "gemini", label: "Gemini", shortLabel: "Gemini", support: "supported" },
	{ id: "antigravity", label: "Antigravity", shortLabel: "Antigravity", support: "unverified" },
	{ id: "cursor", label: "Cursor", shortLabel: "Cursor", support: "supported" },
	{ id: "trae", label: "Trae", shortLabel: "Trae", support: "unverified" },
	{ id: "grok", label: "Grok", shortLabel: "Grok", support: "unverified" },
	{ id: "kimi", label: "Kimi Code", shortLabel: "Kimi Code", support: "supported" },
	{ id: "zed", label: "Zed", shortLabel: "Zed", support: "read-only" },
] as const;

export type AgentId = (typeof AGENT_SOURCES)[number]["id"];
export type AgentSupport = (typeof AGENT_SOURCES)[number]["support"];
export type ConfigurationLevel = "global" | "project" | "temporary";
export type ConfigFormat = "jsonc" | "toml";
export type ConfigFlavor = "generic" | "codex" | "opencode" | "zed";
export type ResolutionStrategy = "whole-record" | "deep-merge" | "independent";
export type EntryResolution = "active" | "disabled" | "shadowed" | "contributes" | "unknown-precedence";
export type RuntimeState =
	| "disconnected"
	| "connecting"
	| "ready"
	| "auth-required"
	| "failed"
	| "closing";

export interface ConfigSourceDescriptor {
	id: string;
	agentId: AgentId;
	agentLabel: string;
	label: string;
	level: ConfigurationLevel;
	scopeKind: string;
	scopeAnchor: string | null;
	path: string;
	rootPath: string[];
	format: ConfigFormat;
	flavor: ConfigFlavor;
	precedence: number | null;
	resolutionStrategy: ResolutionStrategy;
	writable: boolean;
	readOnlyReason?: string;
	exists: boolean;
}

export interface NormalizedServerConfig {
	transport: "stdio" | "http" | "sse" | "unknown";
	command?: string;
	argumentCount: number;
	url?: string;
	enabled: boolean;
	environmentNames: string[];
	headerNames: string[];
}

export interface SourceEntryKeyV1 {
	schemaVersion: 1;
	agentId: AgentId;
	hostId: string;
	scopeKind: string;
	scopeAnchor: string | null;
	configLocator: string;
	entryPointer: string;
	serverKey: string;
}

export interface InternalServerEntry {
	id: string;
	key: SourceEntryKeyV1;
	sourceId: string;
	agentId: AgentId;
	agentLabel: string;
	serverName: string;
	source: ConfigSourceDescriptor;
	rawConfig: Record<string, unknown>;
	normalized: NormalizedServerConfig;
	resolution: EntryResolution;
	originChain: string[];
	effectiveConfig?: Record<string, unknown>;
	runtimeInstanceId?: string;
}

export interface McpServerEntry {
	id: string;
	sourceId: string;
	agentId: AgentId;
	agentLabel: string;
	serverName: string;
	sourceLabel: string;
	level: ConfigurationLevel;
	path: string;
	entryPointer: string;
	writable: boolean;
	readOnlyReason?: string;
	normalized: NormalizedServerConfig;
	config: Record<string, unknown>;
	resolution: EntryResolution;
	originChain: string[];
	runtimeInstanceId?: string;
	runtimeState: RuntimeState;
	runtimeError?: string;
	primitiveCounts?: {
		tools: number;
		resources: number;
		resourceTemplates: number;
		prompts: number;
	};
}

export interface CatalogDiagnostic {
	severity: "warning" | "error";
	agentId: AgentId;
	sourceId?: string;
	path?: string;
	message: string;
}

export interface AgentSummary {
	id: AgentId;
	label: string;
	shortLabel: string;
	support: AgentSupport;
	count: number;
	writableSourceCount: number;
	note?: string;
}

export interface RuntimeSnapshot {
	instanceId: string;
	state: RuntimeState;
	error?: string;
	toolCount: number;
	resourceCount: number;
	resourceTemplateCount: number;
	promptCount: number;
}

export interface McpControlSnapshot {
	revision: number;
	cwd: string;
	projectRoot: string;
	agents: AgentSummary[];
	sources: ConfigSourceDescriptor[];
	entries: McpServerEntry[];
	diagnostics: CatalogDiagnostic[];
}

export interface ChangePlanSummary {
	id: string;
	operation: "add" | "update" | "delete";
	agentId: AgentId;
	serverName: string;
	path: string;
	sourceId: string;
	diff: string;
	expectedHash: string | null;
	createsFile: boolean;
}

export interface CommitResult {
	planId: string;
	path: string;
	backupPath?: string;
	created: boolean;
}

export type McpControlCommand =
	| {
			type: "plan-upsert";
			sourceId: string;
			serverName: string;
			config: Record<string, unknown>;
		}
	| {
			type: "plan-patch";
			entryId: string;
			patch: Record<string, unknown>;
			unset?: string[];
		}
	| { type: "plan-delete"; entryId: string }
	| { type: "commit"; planId: string }
	| { type: "discard-plan"; planId: string }
	| { type: "refresh"; cwd?: string; includeProjectSources?: boolean }
	| { type: "connect"; entryId: string }
	| { type: "disconnect"; entryId: string }
	| { type: "disconnect-all" };

export type McpControlCommandResult =
	| { type: "snapshot"; snapshot: McpControlSnapshot }
	| { type: "plan"; plan: ChangePlanSummary }
	| { type: "committed"; result: CommitResult; snapshot: McpControlSnapshot }
	| { type: "discarded"; planId: string }
	| { type: "runtime"; entryId?: string; state: RuntimeState; snapshot: McpControlSnapshot };

export interface RuntimeServerDefinition {
	instanceId: string;
	entryId: string;
	agentId: AgentId;
	agentLabel: string;
	serverName: string;
	config: Record<string, unknown>;
	flavor: ConfigFlavor;
	cwd: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(value);
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function stableId(prefix: string, value: unknown): string {
	const digest = createHash("sha256").update(canonicalJson(value)).digest("base64url");
	return `${prefix}:v1:${digest}`;
}

export function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function jsonPointer(segments: readonly string[]): string {
	if (segments.length === 0) return "";
	return `/${segments.map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

export function sourceIdFor(source: Omit<ConfigSourceDescriptor, "id" | "exists">): string {
	return stableId("mcp-config-source", {
		agentId: source.agentId,
		scopeKind: source.scopeKind,
		scopeAnchor: source.scopeAnchor,
		path: source.path,
		rootPath: source.rootPath,
	});
}

export function sourceEntryKey(source: ConfigSourceDescriptor, serverName: string, hostId = "local"): SourceEntryKeyV1 {
	return {
		schemaVersion: 1,
		agentId: source.agentId,
		hostId,
		scopeKind: source.scopeKind,
		scopeAnchor: source.scopeAnchor,
		configLocator: source.path,
		entryPointer: jsonPointer([...source.rootPath, serverName]),
		serverKey: serverName,
	};
}

export function entryIdFor(key: SourceEntryKeyV1): string {
	return stableId("mcp-source", key);
}

export function runtimeInstanceIdFor(agentId: AgentId, serverName: string, originChain: readonly string[]): string {
	return stableId("mcp-instance", { agentId, serverName, originChain });
}

export function canonicalPath(filePath: string, cwd = process.cwd()): string {
	return normalize(resolve(cwd, filePath));
}

export function displayPath(filePath: string, home: string): string {
	if (filePath === home) return "~";
	if (filePath.startsWith(`${home}${sep}`)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

export function safeUrl(raw: string): string {
	try {
		const url = new URL(raw);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return "<invalid-or-redacted-url>";
	}
}

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)/i;
const SECRET_CONTAINER = /^(?:env|environment|headers|http_headers)$/i;

function redactValue(value: unknown, key: string, insideSecretContainer: boolean): unknown {
	if (insideSecretContainer || SECRET_KEY.test(key)) return "<redacted>";
	if (SECRET_CONTAINER.test(key)) {
		if (!isRecord(value)) return "<redacted>";
		return Object.fromEntries(Object.keys(value).map((childKey) => [childKey, "<redacted>"]));
	}
	if (key === "args") return Array.isArray(value) ? [`<${value.length} arguments>`] : "<arguments redacted>";
	if (key === "command" && Array.isArray(value)) {
		const executable = typeof value[0] === "string" ? commandLabel(value[0]) : "<command>";
		return [executable, `<${Math.max(0, value.length - 1)} arguments>`];
	}
	if (key === "command" && typeof value === "string") return commandLabel(value);
	if (/url$/i.test(key) && typeof value === "string") return safeUrl(value);
	if (typeof value === "string" && /^(?:https?|wss?):\/\//i.test(value)) return safeUrl(value);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, "", false));
	if (!isRecord(value)) return value;

	return Object.fromEntries(
		Object.entries(value).map(([childKey, childValue]) => [
			childKey,
			redactValue(childValue, childKey, false),
		]),
	);
}

export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
	return redactValue(config, "", false) as Record<string, unknown>;
}

export function commandLabel(command: string | undefined): string | undefined {
	if (!command) return undefined;
	return command.includes(sep) ? basename(command) : command;
}

export function deepMergeRecords(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result = cloneRecord(base);
	for (const [key, value] of Object.entries(override)) {
		const current = result[key];
		result[key] = isRecord(current) && isRecord(value) ? deepMergeRecords(current, value) : structuredClone(value);
	}
	return result;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
