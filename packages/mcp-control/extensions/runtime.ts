import {
	Client,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	type CallToolResult,
	type GetPromptResult,
	type Prompt,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplateType,
	type Tool,
	type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import {
	errorMessage,
	isRecord,
	safeUrl,
	type RuntimeServerDefinition,
	type RuntimeSnapshot,
	type RuntimeState,
} from "./model.ts";

export interface RuntimePrimitiveCatalog {
	tools: Tool[];
	resources: Resource[];
	resourceTemplates: ResourceTemplateType[];
	prompts: Prompt[];
}

interface McpClientLike {
	connect(transport: Transport): Promise<void>;
	close(): Promise<void>;
	listTools(): Promise<{ tools: Tool[] }>;
	listResources(): Promise<{ resources: Resource[] }>;
	listResourceTemplates(): Promise<{ resourceTemplates: ResourceTemplateType[] }>;
	listPrompts(): Promise<{ prompts: Prompt[] }>;
	callTool(
		params: { name: string; arguments?: Record<string, unknown> },
		options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
	): Promise<CallToolResult>;
	readResource(
		params: { uri: string },
		options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
	): Promise<ReadResourceResult>;
	getPrompt(
		params: { name: string; arguments?: Record<string, string> },
		options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
	): Promise<GetPromptResult>;
}

export interface RuntimeFactory {
	createClient(
		definition: RuntimeServerDefinition,
		onListChanged?: (error?: Error) => void,
	): McpClientLike;
	createTransport(definition: RuntimeServerDefinition): Transport;
}

interface RuntimeConnection {
	definition: RuntimeServerDefinition;
	state: RuntimeState;
	error?: string;
	client?: McpClientLike;
	transport?: Transport;
	catalog: RuntimePrimitiveCatalog;
}

export type RuntimeListener = (instanceId: string, snapshot: RuntimeSnapshot, catalog: RuntimePrimitiveCatalog) => void;

function emptyCatalog(): RuntimePrimitiveCatalog {
	return { tools: [], resources: [], resourceTemplates: [], prompts: [] };
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function expandEnvironmentValue(value: string, environment: NodeJS.ProcessEnv): string {
	return value
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
			return environment[name] ?? fallback ?? "";
		})
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => environment[name] ?? "");
}

function runtimeTransportConfig(definition: RuntimeServerDefinition): {
	transport: "stdio" | "http" | "sse";
	command?: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	url?: string;
	headers: Record<string, string>;
} {
	const config = definition.config;
	const nestedCommand = isRecord(config.command) ? config.command : undefined;
	const openCodeCommand = definition.flavor === "opencode" ? stringArray(config.command) : [];
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
	const explicitType = typeof config.type === "string" ? config.type.toLowerCase() : "";
	const explicitTransport = typeof config.transport === "string" ? config.transport.toLowerCase() : "";
	const transport = rawUrl
		? explicitType === "sse" || explicitTransport === "sse"
			? "sse"
			: "http"
		: "stdio";

	const configuredEnvironment = {
		...stringRecord(nestedCommand?.env),
		...stringRecord(config.environment),
		...stringRecord(config.env),
	};
	const inheritedByName = stringArray(config.env_vars);
	const env: Record<string, string> = { ...getDefaultEnvironment() };
	for (const name of inheritedByName) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	for (const [name, value] of Object.entries(configuredEnvironment)) {
		env[name] = expandEnvironmentValue(value, process.env);
	}

	const headers = {
		...stringRecord(config.http_headers),
		...stringRecord(config.headers),
	};
	for (const [name, value] of Object.entries(headers)) headers[name] = expandEnvironmentValue(value, process.env);
	for (const [headerName, environmentName] of Object.entries(stringRecord(config.env_http_headers))) {
		const value = process.env[environmentName];
		if (value !== undefined) headers[headerName] = value;
	}
	if (typeof config.bearer_token_env_var === "string") {
		const token = process.env[config.bearer_token_env_var];
		if (token) headers.Authorization = `Bearer ${token}`;
	}

	return {
		transport,
		command,
		args,
		env,
		cwd:
			(typeof config.cwd === "string" ? config.cwd : undefined) ??
			(typeof nestedCommand?.cwd === "string" ? nestedCommand.cwd : undefined) ??
			definition.cwd,
		url: rawUrl,
		headers,
	};
}

function safeError(error: unknown): string {
	let message = errorMessage(error)
		.replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
		.replace(/(authorization|cookie|password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
	message = message.replace(/https?:\/\/[^\s)]+/gi, (url) => safeUrl(url));
	return message.slice(0, 800);
}

function isAuthError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { name?: unknown; status?: unknown; code?: unknown };
	return (
		candidate.name === "UnauthorizedError" ||
		candidate.status === 401 ||
		candidate.code === "CLIENT_HTTP_AUTHENTICATION"
	);
}

export const defaultRuntimeFactory: RuntimeFactory = {
	createClient(_definition, onListChanged) {
		const changed = (error: Error | null) => onListChanged?.(error ?? undefined);
		return new Client(
			{ name: "@async23/pi-mcp-control", version: "0.1.0" },
			{
				capabilities: {},
				versionNegotiation: { mode: "auto", probe: { timeoutMs: 2500, maxRetries: 0 } },
				inputRequired: { autoFulfill: false, maxRounds: 1 },
				listMaxPages: 64,
				listChanged: {
					tools: { autoRefresh: false, debounceMs: 300, onChanged: changed },
					resources: { autoRefresh: false, debounceMs: 300, onChanged: changed },
					prompts: { autoRefresh: false, debounceMs: 300, onChanged: changed },
				},
			},
		);
	},

	createTransport(definition) {
		const config = runtimeTransportConfig(definition);
		if (config.transport === "stdio") {
			if (!config.command) throw new Error("stdio MCP server has no command");
			const transport = new StdioClientTransport({
				command: config.command,
				args: config.args,
				env: config.env,
				cwd: config.cwd,
				stderr: "pipe",
			});
			transport.stderr?.on("data", () => {
				// Keep server stderr away from Pi's terminal. A bounded diagnostic tail can be added later.
			});
			return transport;
		}
		if (!config.url) throw new Error("remote MCP server has no URL");
		const url = new URL(config.url);
		const requestInit = Object.keys(config.headers).length > 0 ? { headers: config.headers } : undefined;
		return config.transport === "sse"
			? new SSEClientTransport(url, { requestInit })
			: new StreamableHTTPClientTransport(url, { requestInit });
	},
};

export class McpRuntimeManager {
	readonly #factory: RuntimeFactory;
	readonly #connections = new Map<string, RuntimeConnection>();
	readonly #listeners = new Set<RuntimeListener>();

	constructor(factory: RuntimeFactory = defaultRuntimeFactory) {
		this.#factory = factory;
	}

	subscribe(listener: RuntimeListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	snapshot(instanceId: string): RuntimeSnapshot {
		const connection = this.#connections.get(instanceId);
		return {
			instanceId,
			state: connection?.state ?? "disconnected",
			error: connection?.error,
			toolCount: connection?.catalog.tools.length ?? 0,
			resourceCount: connection?.catalog.resources.length ?? 0,
			resourceTemplateCount: connection?.catalog.resourceTemplates.length ?? 0,
			promptCount: connection?.catalog.prompts.length ?? 0,
		};
	}

	catalog(instanceId: string): RuntimePrimitiveCatalog {
		return this.#connections.get(instanceId)?.catalog ?? emptyCatalog();
	}

	#emit(instanceId: string): void {
		const snapshot = this.snapshot(instanceId);
		const catalog = this.catalog(instanceId);
		for (const listener of this.#listeners) listener(instanceId, snapshot, catalog);
	}

	async connect(definition: RuntimeServerDefinition): Promise<RuntimeSnapshot> {
		const current = this.#connections.get(definition.instanceId);
		if (current?.state === "ready" || current?.state === "connecting") return this.snapshot(definition.instanceId);
		const connection: RuntimeConnection = {
			definition,
			state: "connecting",
			catalog: emptyCatalog(),
		};
		this.#connections.set(definition.instanceId, connection);
		this.#emit(definition.instanceId);
		try {
			connection.client = this.#factory.createClient(definition, (error) => {
				void this.#handleListChanged(definition.instanceId, error);
			});
			connection.transport = this.#factory.createTransport(definition);
			await connection.client.connect(connection.transport);
			connection.catalog = await this.#loadCatalog(connection.client);
			connection.state = "ready";
			connection.error = undefined;
		} catch (error) {
			connection.state = isAuthError(error) ? "auth-required" : "failed";
			connection.error = safeError(error);
			try {
				await connection.client?.close();
			} catch {
				// The original connection failure is the useful diagnostic.
			}
			connection.client = undefined;
			connection.transport = undefined;
		}
		this.#emit(definition.instanceId);
		return this.snapshot(definition.instanceId);
	}

	async #handleListChanged(instanceId: string, error?: Error): Promise<void> {
		const connection = this.#connections.get(instanceId);
		if (!connection) return;
		if (error) {
			connection.error = safeError(error);
			this.#emit(instanceId);
			return;
		}
		if (!connection.client || connection.state !== "ready") return;
		try {
			connection.catalog = await this.#loadCatalog(connection.client);
			connection.error = undefined;
		} catch (refreshError) {
			connection.error = safeError(refreshError);
		}
		this.#emit(instanceId);
	}

	async #loadCatalog(client: McpClientLike): Promise<RuntimePrimitiveCatalog> {
		const [tools, resources, templates, prompts] = await Promise.allSettled([
			client.listTools(),
			client.listResources(),
			client.listResourceTemplates(),
			client.listPrompts(),
		]);
		return {
			tools: tools.status === "fulfilled" ? tools.value.tools : [],
			resources: resources.status === "fulfilled" ? resources.value.resources : [],
			resourceTemplates: templates.status === "fulfilled" ? templates.value.resourceTemplates : [],
			prompts: prompts.status === "fulfilled" ? prompts.value.prompts : [],
		};
	}

	async refresh(instanceId: string): Promise<RuntimeSnapshot> {
		const connection = this.#readyConnection(instanceId);
		connection.catalog = await this.#loadCatalog(connection.client);
		this.#emit(instanceId);
		return this.snapshot(instanceId);
	}

	async disconnect(instanceId: string): Promise<RuntimeSnapshot> {
		const connection = this.#connections.get(instanceId);
		if (!connection) return this.snapshot(instanceId);
		connection.state = "closing";
		this.#emit(instanceId);
		try {
			await connection.client?.close();
		} catch (error) {
			connection.error = safeError(error);
		} finally {
			connection.client = undefined;
			connection.transport = undefined;
			connection.catalog = emptyCatalog();
			connection.state = "disconnected";
			this.#emit(instanceId);
		}
		return this.snapshot(instanceId);
	}

	async disconnectAll(): Promise<void> {
		await Promise.all([...this.#connections.keys()].map((instanceId) => this.disconnect(instanceId)));
	}

	#readyConnection(instanceId: string): RuntimeConnection & { client: McpClientLike } {
		const connection = this.#connections.get(instanceId);
		if (!connection?.client || connection.state !== "ready") throw new Error(`MCP server is not connected: ${instanceId}`);
		return connection as RuntimeConnection & { client: McpClientLike };
	}

	callTool(
		instanceId: string,
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		return this.#readyConnection(instanceId).client.callTool(
			{ name, arguments: args },
			{ signal, timeout: 60_000, maxTotalTimeout: 10 * 60_000 },
		);
	}

	readResource(instanceId: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		return this.#readyConnection(instanceId).client.readResource(
			{ uri },
			{ signal, timeout: 60_000, maxTotalTimeout: 2 * 60_000 },
		);
	}

	getPrompt(
		instanceId: string,
		name: string,
		args: Record<string, string>,
		signal?: AbortSignal,
	): Promise<GetPromptResult> {
		return this.#readyConnection(instanceId).client.getPrompt(
			{ name, arguments: args },
			{ signal, timeout: 60_000, maxTotalTimeout: 2 * 60_000 },
		);
	}
}
