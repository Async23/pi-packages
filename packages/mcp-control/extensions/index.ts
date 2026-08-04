import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { McpControl } from "./control.ts";
import { formatPromptResult } from "./content.ts";
import {
	errorMessage,
	isRecord,
	type AgentId,
	type ChangePlanSummary,
	type ConfigFlavor,
	type ConfigSourceDescriptor,
	type McpControlSnapshot,
	type McpServerEntry,
	type RuntimeServerDefinition,
} from "./model.ts";
import { McpControlPanel, type McpPanelCursor, type McpPanelResult } from "./panel.ts";
import { McpRuntimeManager } from "./runtime.ts";
import { PiToolBridge } from "./tool-bridge.ts";

export * from "./codecs.ts";
export * from "./content.ts";
export * from "./control.ts";
export * from "./file-store.ts";
export * from "./model.ts";
export * from "./mutation.ts";
export * from "./panel.ts";
export * from "./policy.ts";
export * from "./runtime.ts";
export * from "./sources.ts";
export * from "./tool-bridge.ts";

function parseStringArray(input: string): string[] {
	const trimmed = input.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		const parsed: unknown = JSON.parse(trimmed);
		if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
			throw new Error("Arguments JSON must be an array of strings.");
		}
		return parsed;
	}

	const result: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const character of trimmed) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) {
				result.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (escaped || quote) throw new Error("Arguments contain an unfinished escape or quote.");
	if (current) result.push(current);
	return result;
}

function parseStringMap(input: string, label: string): Record<string, string> {
	const trimmed = input.trim();
	if (!trimmed) return {};
	const parsed: unknown = JSON.parse(trimmed);
	if (!isRecord(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
		throw new Error(`${label} must be a JSON object whose values are strings.`);
	}
	return parsed as Record<string, string>;
}

async function optionalStringMap(
	ctx: ExtensionCommandContext,
	title: string,
	label: string,
): Promise<Record<string, string> | undefined> {
	const value = await ctx.ui.input(title, "Optional JSON object, e.g. {\"NAME\":\"value\"}");
	if (value === undefined) return undefined;
	return parseStringMap(value, label);
}

function buildStdioConfig(
	flavor: ConfigFlavor,
	command: string,
	args: string[],
	environment: Record<string, string>,
): Record<string, unknown> {
	if (flavor === "opencode") {
		return {
			type: "local",
			command: [command, ...args],
			enabled: true,
			...(Object.keys(environment).length > 0 ? { environment } : {}),
		};
	}
	return {
		command,
		...(args.length > 0 ? { args } : {}),
		...(Object.keys(environment).length > 0 ? { env: environment } : {}),
	};
}

function buildRemoteConfig(
	flavor: ConfigFlavor,
	transport: "http" | "sse",
	url: string,
	headers: Record<string, string>,
): Record<string, unknown> {
	if (flavor === "opencode") {
		return {
			type: "remote",
			url,
			enabled: true,
			...(transport === "sse" ? { transport: "sse" } : {}),
			...(Object.keys(headers).length > 0 ? { headers } : {}),
		};
	}
	return {
		type: transport,
		url,
		...(Object.keys(headers).length > 0 ? { headers } : {}),
	};
}

async function collectNewServerConfig(
	ctx: ExtensionCommandContext,
	source: ConfigSourceDescriptor,
): Promise<Record<string, unknown> | undefined> {
	const transportChoice = await ctx.ui.select("MCP transport", [
		"stdio — local command",
		"HTTP — remote Streamable HTTP",
		"SSE — legacy remote transport",
	]);
	if (!transportChoice) return undefined;

	if (transportChoice.startsWith("stdio")) {
		const command = await ctx.ui.input("Server command", "Executable, e.g. npx");
		if (!command?.trim()) return undefined;
		const argumentText = await ctx.ui.input("Arguments", "Optional shell-style arguments or JSON string array");
		if (argumentText === undefined) return undefined;
		const environment = await optionalStringMap(ctx, "Environment", "Environment");
		if (environment === undefined) return undefined;
		return buildStdioConfig(source.flavor, command.trim(), parseStringArray(argumentText), environment);
	}

	const url = await ctx.ui.input("Server URL", "https://example.com/mcp");
	if (!url?.trim()) return undefined;
	const parsedUrl = new URL(url.trim());
	if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("Remote MCP URL must use http:// or https://.");
	const headers = await optionalStringMap(ctx, "HTTP headers", "Headers");
	if (headers === undefined) return undefined;
	return buildRemoteConfig(source.flavor, transportChoice.startsWith("SSE") ? "sse" : "http", url.trim(), headers);
}

async function confirmPlan(
	control: McpControl,
	plan: ChangePlanSummary,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	const confirmed = await ctx.ui.confirm(
		`${plan.operation === "delete" ? "Delete" : plan.operation === "add" ? "Add" : "Update"} MCP server?`,
		[
			`${plan.agentId} / ${plan.serverName}`,
			plan.path,
			"",
			plan.diff,
			"",
			plan.createsFile ? "The config file will be created atomically." : "The current config file will be backed up before an atomic replacement.",
		].join("\n"),
	);
	if (!confirmed) {
		await control.execute({ type: "discard-plan", planId: plan.id });
		return false;
	}
	const committed = await control.execute({ type: "commit", planId: plan.id });
	if (committed.type !== "committed") throw new Error("Unexpected MCP commit result.");
	ctx.ui.notify(
		committed.result.backupPath
			? `MCP config saved. Backup: ${committed.result.backupPath}`
			: `MCP config created: ${committed.result.path}`,
		"info",
	);
	return true;
}

async function addServer(
	control: McpControl,
	snapshot: McpControlSnapshot,
	agentId: AgentId,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const sources = snapshot.sources.filter((source) => source.agentId === agentId && source.writable);
	if (sources.length === 0) {
		const note = snapshot.agents.find((agent) => agent.id === agentId)?.note;
		ctx.ui.notify(note ?? `No writable MCP configuration source is known for ${agentId}.`, "warning");
		return;
	}
	const labels = sources.map((source) => `${source.level === "global" ? "Global" : "Project"} · ${source.label}`);
	const selectedLabel = await ctx.ui.select("Write to Agent configuration", labels);
	if (!selectedLabel) return;
	const source = sources[labels.indexOf(selectedLabel)];
	if (!source) return;
	const serverName = await ctx.ui.input("MCP server name", "Stable name used by this Agent");
	if (!serverName?.trim()) return;
	const config = await collectNewServerConfig(ctx, source);
	if (!config) return;
	const result = await control.execute({ type: "plan-upsert", sourceId: source.id, serverName, config });
	if (result.type !== "plan") throw new Error("Unexpected MCP plan result.");
	await confirmPlan(control, result.plan, ctx);
}

async function replaceTransport(
	control: McpControl,
	entry: McpServerEntry,
	ctx: ExtensionCommandContext,
): Promise<ChangePlanSummary | undefined> {
	const source = control.snapshot().sources.find((candidate) => candidate.id === entry.sourceId);
	if (!source) throw new Error("MCP source disappeared during edit.");
	const config = await collectNewServerConfig(ctx, source);
	if (!config) return undefined;
	const result = await control.execute({
		type: "plan-patch",
		entryId: entry.id,
		patch: config,
		unset: [
			"command",
			"args",
			"env",
			"environment",
			"url",
			"httpUrl",
			"serverUrl",
			"headers",
			"http_headers",
			"transport",
			"type",
		].filter((key) => !(key in config)),
	});
	return result.type === "plan" ? result.plan : undefined;
}

async function editServer(
	control: McpControl,
	entry: McpServerEntry,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!entry.writable) {
		ctx.ui.notify(entry.readOnlyReason ?? "This MCP source is read-only.", "warning");
		return;
	}
	const actions = ["Toggle enabled", "Replace transport definition", "Set one top-level field"];
	if (entry.normalized.transport === "stdio") actions.splice(1, 0, "Command and arguments", "Environment");
	if (entry.normalized.transport === "http" || entry.normalized.transport === "sse") actions.splice(1, 0, "URL", "HTTP headers");
	const action = await ctx.ui.select(`Edit ${entry.agentLabel} / ${entry.serverName}`, actions);
	if (!action) return;

	let plan: ChangePlanSummary | undefined;
	if (action === "Toggle enabled") {
		const result = await control.execute({
			type: "plan-patch",
			entryId: entry.id,
			patch: { enabled: !entry.normalized.enabled },
			unset: ["disabled"],
		});
		if (result.type === "plan") plan = result.plan;
	} else if (action === "Replace transport definition") {
		plan = await replaceTransport(control, entry, ctx);
	} else if (action === "Command and arguments") {
		const line = await ctx.ui.input("Command and arguments", "Executable followed by shell-style arguments");
		if (!line?.trim()) return;
		const parts = parseStringArray(line);
		if (parts.length === 0) return;
		const source = control.snapshot().sources.find((candidate) => candidate.id === entry.sourceId);
		const patch = source?.flavor === "opencode" ? { command: parts } : { command: parts[0], args: parts.slice(1) };
		const result = await control.execute({ type: "plan-patch", entryId: entry.id, patch });
		if (result.type === "plan") plan = result.plan;
	} else if (action === "Environment") {
		const environment = await optionalStringMap(ctx, "Replace environment", "Environment");
		if (environment === undefined) return;
		const source = control.snapshot().sources.find((candidate) => candidate.id === entry.sourceId);
		const field = source?.flavor === "opencode" ? "environment" : "env";
		const result = await control.execute({ type: "plan-patch", entryId: entry.id, patch: { [field]: environment } });
		if (result.type === "plan") plan = result.plan;
	} else if (action === "URL") {
		const url = await ctx.ui.input("Replace server URL", entry.normalized.url ?? "https://example.com/mcp");
		if (!url?.trim()) return;
		const parsed = new URL(url.trim());
		if (!/^https?:$/.test(parsed.protocol)) throw new Error("Remote MCP URL must use http:// or https://.");
		const result = await control.execute({ type: "plan-patch", entryId: entry.id, patch: { url: url.trim() } });
		if (result.type === "plan") plan = result.plan;
	} else if (action === "HTTP headers") {
		const headers = await optionalStringMap(ctx, "Replace HTTP headers", "Headers");
		if (headers === undefined) return;
		const result = await control.execute({ type: "plan-patch", entryId: entry.id, patch: { headers } });
		if (result.type === "plan") plan = result.plan;
	} else if (action === "Set one top-level field") {
		const field = await ctx.ui.input("Field name", "Existing or new top-level server field");
		if (!field?.trim()) return;
		const rawValue = await ctx.ui.input("JSON value", "Examples: true, 30000, \"value\", [\"tool\"]");
		if (rawValue === undefined) return;
		const value: unknown = JSON.parse(rawValue);
		const result = await control.execute({ type: "plan-patch", entryId: entry.id, patch: { [field.trim()]: value } });
		if (result.type === "plan") plan = result.plan;
	}
	if (plan) await confirmPlan(control, plan, ctx);
}

async function deleteServer(control: McpControl, entry: McpServerEntry, ctx: ExtensionCommandContext): Promise<void> {
	if (!entry.writable) {
		ctx.ui.notify(entry.readOnlyReason ?? "This MCP source is read-only.", "warning");
		return;
	}
	const result = await control.execute({ type: "plan-delete", entryId: entry.id });
	if (result.type !== "plan") throw new Error("Unexpected MCP delete plan result.");
	await confirmPlan(control, result.plan, ctx);
}

async function invokePrompt(
	pi: ExtensionAPI,
	runtime: McpRuntimeManager,
	entry: McpServerEntry,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	if (entry.runtimeState !== "ready" || !entry.runtimeInstanceId) {
		ctx.ui.notify("Connect this MCP server before invoking one of its prompts.", "warning");
		return false;
	}
	const prompts = runtime.catalog(entry.runtimeInstanceId).prompts;
	if (prompts.length === 0) {
		ctx.ui.notify("This MCP server exposes no prompts.", "warning");
		return false;
	}
	const labels = prompts.map((prompt) => `${prompt.name}${prompt.description ? ` — ${prompt.description}` : ""}`);
	const selected = await ctx.ui.select(`Prompt from ${entry.agentLabel} / ${entry.serverName}`, labels);
	if (!selected) return false;
	const prompt = prompts[labels.indexOf(selected)];
	if (!prompt) return false;
	const args: Record<string, string> = {};
	for (const argument of prompt.arguments ?? []) {
		const value = await ctx.ui.input(
			`${argument.name}${argument.required ? " (required)" : ""}`,
			argument.description ?? "Prompt argument",
		);
		if (value === undefined) return false;
		if (argument.required && value.trim() === "") {
			ctx.ui.notify(`Prompt argument '${argument.name}' is required.`, "error");
			return false;
		}
		if (value !== "") args[argument.name] = value;
	}
	const result = await runtime.getPrompt(entry.runtimeInstanceId, prompt.name, args);
	const text = formatPromptResult(result);
	pi.sendUserMessage(
		`<mcp_prompt source_agent="${escapeXmlAttribute(entry.agentLabel)}" source_server="${escapeXmlAttribute(entry.serverName)}" prompt="${escapeXmlAttribute(prompt.name)}">\n${text}\n</mcp_prompt>`,
	);
	return true;
}

function entryFromSnapshot(snapshot: McpControlSnapshot, entryId: string): McpServerEntry {
	const entry = snapshot.entries.find((candidate) => candidate.id === entryId);
	if (!entry) throw new Error("The selected MCP server entry no longer exists. Refresh and try again.");
	return entry;
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export default function mcpControlExtension(pi: ExtensionAPI) {
	const runtime = new McpRuntimeManager();
	let bridge: PiToolBridge;
	const control = new McpControl({
		runtime,
		includeProjectSources: false,
		onWillConnect(definition: RuntimeServerDefinition) {
			bridge.track(definition);
		},
	});
	bridge = new PiToolBridge(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		const result = await control.execute({
			type: "refresh",
			cwd: ctx.cwd,
			includeProjectSources: ctx.isProjectTrusted(),
		});
		if (result.type !== "snapshot") return;
		const errors = result.snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0) ctx.ui.notify(`${errors.length} MCP config source${errors.length === 1 ? " has" : "s have"} parse errors. Open /mcp for details.`, "warning");
	});

	pi.on("session_shutdown", async () => {
		await control.execute({ type: "disconnect-all" });
		bridge.dispose();
	});

	pi.registerCommand("mcp", {
		description: "Manage Agent-scoped MCP configurations and connections",
		handler: async (args, ctx) => {
			if (args.trim() !== "") {
				ctx.ui.notify("Usage: /mcp", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/mcp requires TUI mode", "error");
				return;
			}

			let cursor: McpPanelCursor | undefined;
			while (true) {
				try {
					const snapshot = control.snapshot();
					const result = await ctx.ui.custom<McpPanelResult>(
						(tui, theme, keybindings, done) =>
							new McpControlPanel({ tui, theme, keybindings, snapshot, cursor, onDone: done }),
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
					cursor = result.cursor;
					if (result.action === "close") return;
					if (result.action === "refresh") {
						await control.execute({ type: "refresh", cwd: ctx.cwd });
						continue;
					}
					if (result.action === "add") {
						await addServer(control, control.snapshot(), result.agentId, ctx);
						continue;
					}
					const entry = entryFromSnapshot(control.snapshot(), result.entryId);
					if (result.action === "edit") await editServer(control, entry, ctx);
					else if (result.action === "delete") await deleteServer(control, entry, ctx);
					else if (result.action === "connect") {
						ctx.ui.setStatus("mcp-control", `Connecting ${entry.agentLabel} / ${entry.serverName}…`);
						const connected = await control.execute({ type: "connect", entryId: entry.id });
						ctx.ui.setStatus("mcp-control", undefined);
						if (connected.type === "runtime") {
							ctx.ui.notify(
								connected.state === "ready"
									? `Connected ${entry.agentLabel} / ${entry.serverName}`
									: `Could not connect ${entry.agentLabel} / ${entry.serverName}: ${entryFromSnapshot(connected.snapshot, entry.id).runtimeError ?? connected.state}`,
								connected.state === "ready" ? "info" : "error",
							);
						}
					} else if (result.action === "disconnect") {
						await control.execute({ type: "disconnect", entryId: entry.id });
						ctx.ui.notify(`Disconnected ${entry.agentLabel} / ${entry.serverName}`, "info");
					} else if (result.action === "prompt") {
						if (await invokePrompt(pi, runtime, entry, ctx)) return;
					}
				} catch (error) {
					ctx.ui.setStatus("mcp-control", undefined);
					ctx.ui.notify(errorMessage(error), "error");
				}
			}
		},
	});
}
