import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import mcpControlExtension, {
	McpControl,
	McpRuntimeManager,
	NodeConfigFileStore,
	PiToolBridge,
	piToolName,
} from "../extensions/index.ts";

const stdioServerPath = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

function makeSandbox(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-mcp-control-integration-"));
	const home = join(root, "home");
	const projectRoot = join(root, "project");
	mkdirSync(home, { recursive: true });
	mkdirSync(join(projectRoot, ".git"), { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { home, projectRoot };
}

test("a user can add, preview, edit, back up, and delete one Agent's MCP without touching another", async (t) => {
	const { home, projectRoot } = makeSandbox(t);
	const claudePath = join(home, ".claude.json");
	const claudeBefore = `${JSON.stringify({ mcpServers: { shared: { command: "claude-server" } } }, null, 2)}\n`;
	writeFileSync(claudePath, claudeBefore, { encoding: "utf8", mode: 0o600 });

	const control = new McpControl({
		cwd: projectRoot,
		home,
		projectRoot,
		platform: process.platform,
		pathExists: existsSync,
		includeProjectSources: true,
		fileStore: new NodeConfigFileStore(),
	});
	const piSource = control
		.snapshot()
		.sources.find((source) => source.agentId === "pi" && source.level === "global" && source.writable);
	assert.ok(piSource);

	const add = await control.execute({
		type: "plan-upsert",
		sourceId: piSource.id,
		serverName: "shared",
		config: {
			command: process.execPath,
			args: ["fixture-v1.mjs"],
			env: { TOKEN: "integration-secret" },
		},
	});
	assert.equal(add.type, "plan");
	assert.equal(add.plan.operation, "add");
	assert.equal(add.plan.createsFile, true);
	assert.doesNotMatch(add.plan.diff, /integration-secret/);
	const added = await control.execute({ type: "commit", planId: add.plan.id });
	assert.equal(added.type, "committed");
	assert.equal(added.result.backupPath, undefined);

	const piPath = join(home, ".pi", "agent", "mcp.json");
	const afterAdd = readFileSync(piPath, "utf8");
	assert.deepEqual(JSON.parse(afterAdd), {
		mcpServers: {
			shared: {
				command: process.execPath,
				args: ["fixture-v1.mjs"],
				env: { TOKEN: "integration-secret" },
			},
		},
	});
	assert.equal(readFileSync(claudePath, "utf8"), claudeBefore);

	const piEntry = added.snapshot.entries.find(
		(entry) => entry.agentId === "pi" && entry.serverName === "shared",
	);
	assert.ok(piEntry);
	const edit = await control.execute({
		type: "plan-patch",
		entryId: piEntry.id,
		patch: { args: ["fixture-v2.mjs"], enabled: false },
	});
	assert.equal(edit.type, "plan");
	assert.equal(edit.plan.operation, "update");
	assert.match(edit.plan.diff, /"enabled": false/);
	assert.doesNotMatch(edit.plan.diff, /integration-secret/);
	const beforeEdit = readFileSync(piPath, "utf8");
	const edited = await control.execute({ type: "commit", planId: edit.plan.id });
	assert.equal(edited.type, "committed");
	assert.ok(edited.result.backupPath);
	assert.equal(readFileSync(edited.result.backupPath, "utf8"), beforeEdit);
	assert.deepEqual(JSON.parse(readFileSync(piPath, "utf8")).mcpServers.shared.args, ["fixture-v2.mjs"]);
	assert.equal(JSON.parse(readFileSync(piPath, "utf8")).mcpServers.shared.enabled, false);
	assert.equal(readFileSync(claudePath, "utf8"), claudeBefore);

	const editedEntry = edited.snapshot.entries.find(
		(entry) => entry.agentId === "pi" && entry.serverName === "shared",
	);
	assert.ok(editedEntry);
	const remove = await control.execute({ type: "plan-delete", entryId: editedEntry.id });
	assert.equal(remove.type, "plan");
	assert.equal(remove.plan.operation, "delete");
	const beforeDelete = readFileSync(piPath, "utf8");
	const removed = await control.execute({ type: "commit", planId: remove.plan.id });
	assert.equal(removed.type, "committed");
	assert.ok(removed.result.backupPath);
	assert.equal(readFileSync(removed.result.backupPath, "utf8"), beforeDelete);
	assert.deepEqual(JSON.parse(readFileSync(piPath, "utf8")), { mcpServers: {} });
	assert.equal(readFileSync(claudePath, "utf8"), claudeBefore);
	assert.equal(
		removed.snapshot.entries.some((entry) => entry.agentId === "pi" && entry.serverName === "shared"),
		false,
	);
	assert.equal(
		removed.snapshot.entries.some((entry) => entry.agentId === "claude" && entry.serverName === "shared"),
		true,
	);
});

test("a real stdio MCP connection exposes a callable Pi tool and removes it on disconnect", async (t) => {
	const registeredTools = new Map();
	let activeTools = ["native-tool"];
	const pi = {
		registerTool(tool) {
			registeredTools.set(tool.name, tool);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names) {
			activeTools = [...names];
		},
	};
	const runtime = new McpRuntimeManager();
	const bridge = new PiToolBridge(pi, runtime);
	const definition = {
		instanceId: "integration:pi:echo",
		entryId: "integration-entry",
		agentId: "pi",
		agentLabel: "Pi",
		serverName: "isolated-echo",
		config: { command: process.execPath, args: [stdioServerPath] },
		flavor: "generic",
		cwd: process.cwd(),
	};
	bridge.track(definition);
	t.after(async () => {
		await runtime.disconnectAll();
		bridge.dispose();
	});

	const connected = await runtime.connect(definition);
	assert.equal(connected.state, "ready", connected.error);
	assert.equal(connected.toolCount, 1);
	const toolName = piToolName(definition, "echo");
	assert.deepEqual(activeTools, ["native-tool", toolName]);
	const tool = registeredTools.get(toolName);
	assert.ok(tool);
	const callResult = await tool.execute(
		"integration-call",
		{ text: "hello" },
		new AbortController().signal,
		() => undefined,
		{},
	);
	assert.equal(callResult.content[0].text, "echo:hello");

	const disconnected = await runtime.disconnect(definition.instanceId);
	assert.equal(disconnected.state, "disconnected");
	assert.equal(disconnected.toolCount, 0);
	assert.deepEqual(activeTools, ["native-tool"]);
});

test("a malformed existing Agent config is reported and cannot be overwritten by an add", async (t) => {
	const { home, projectRoot } = makeSandbox(t);
	const piPath = join(home, ".pi", "agent", "mcp.json");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const malformed = '{ "mcpServers": { "broken": { "command": "node" }';
	writeFileSync(piPath, malformed, { encoding: "utf8", mode: 0o600 });
	const control = new McpControl({
		cwd: projectRoot,
		home,
		projectRoot,
		platform: process.platform,
		pathExists: existsSync,
		includeProjectSources: true,
		fileStore: new NodeConfigFileStore(),
	});
	const snapshot = control.snapshot();
	assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.severity === "error"), true);
	const piSource = snapshot.sources.find(
		(source) => source.agentId === "pi" && source.level === "global" && source.writable,
	);
	assert.ok(piSource);

	await assert.rejects(
		control.execute({
			type: "plan-upsert",
			sourceId: piSource.id,
			serverName: "new-server",
			config: { command: process.execPath },
		}),
	);
	assert.equal(readFileSync(piPath, "utf8"), malformed);
});

test("a failed MCP command reports runtime failure without changing its Agent config", async (t) => {
	const { home, projectRoot } = makeSandbox(t);
	const piPath = join(home, ".pi", "agent", "mcp.json");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const before = `${JSON.stringify(
		{
			mcpServers: {
				broken: { command: join(projectRoot, "missing-mcp-command") },
			},
		},
		null,
		2,
	)}\n`;
	writeFileSync(piPath, before, { encoding: "utf8", mode: 0o600 });
	const control = new McpControl({
		cwd: projectRoot,
		home,
		projectRoot,
		platform: process.platform,
		pathExists: existsSync,
		includeProjectSources: true,
		fileStore: new NodeConfigFileStore(),
	});
	t.after(() => control.execute({ type: "disconnect-all" }));
	const entry = control.snapshot().entries.find(
		(candidate) => candidate.agentId === "pi" && candidate.serverName === "broken",
	);
	assert.ok(entry);

	const connected = await control.execute({ type: "connect", entryId: entry.id });
	assert.equal(connected.type, "runtime");
	assert.equal(connected.state, "failed");
	const failedEntry = connected.snapshot.entries.find((candidate) => candidate.id === entry.id);
	assert.equal(failedEntry?.runtimeState, "failed");
	assert.ok(failedEntry?.runtimeError);
	assert.equal(readFileSync(piPath, "utf8"), before);
});

test("same-name MCP servers stay isolated by Agent while connected", async (t) => {
	const registeredTools = new Map();
	let activeTools = ["native-tool"];
	const pi = {
		registerTool(tool) {
			registeredTools.set(tool.name, tool);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names) {
			activeTools = [...names];
		},
	};
	const runtime = new McpRuntimeManager();
	const bridge = new PiToolBridge(pi, runtime);
	const definitions = [
		{
			instanceId: "integration:pi:shared",
			entryId: "pi-entry",
			agentId: "pi",
			agentLabel: "Pi",
			serverName: "shared",
			config: { command: process.execPath, args: [stdioServerPath] },
			flavor: "generic",
			cwd: process.cwd(),
		},
		{
			instanceId: "integration:claude:shared",
			entryId: "claude-entry",
			agentId: "claude",
			agentLabel: "Claude",
			serverName: "shared",
			config: { command: process.execPath, args: [stdioServerPath] },
			flavor: "generic",
			cwd: process.cwd(),
		},
	];
	for (const definition of definitions) bridge.track(definition);
	t.after(async () => {
		await runtime.disconnectAll();
		bridge.dispose();
	});

	for (const definition of definitions) {
		const connected = await runtime.connect(definition);
		assert.equal(connected.state, "ready", connected.error);
	}
	const piTool = piToolName(definitions[0], "echo");
	const claudeTool = piToolName(definitions[1], "echo");
	assert.notEqual(piTool, claudeTool);
	assert.deepEqual(activeTools, ["native-tool", piTool, claudeTool]);
	assert.equal(registeredTools.has(piTool), true);
	assert.equal(registeredTools.has(claudeTool), true);

	await runtime.disconnect(definitions[0].instanceId);
	assert.deepEqual(activeTools, ["native-tool", claudeTool]);
	const claudeResult = await registeredTools.get(claudeTool).execute(
		"claude-call",
		{ text: "still-connected" },
		new AbortController().signal,
		() => undefined,
		{},
	);
	assert.equal(claudeResult.content[0].text, "echo:still-connected");
});

test("the /mcp command completes add, edit, connect, disconnect, and delete in an isolated HOME", async (t) => {
	const { home, projectRoot } = makeSandbox(t);
	const handlers = new Map();
	const commands = new Map();
	const registeredTools = new Map();
	let activeTools = ["native-tool"];
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerTool(tool) {
			registeredTools.set(tool.name, tool);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names) {
			activeTools = [...names];
		},
		sendUserMessage() {},
	};
	const originalHome = process.env.HOME;
	process.env.HOME = home;
	try {
		mcpControlExtension(pi);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
	}
	const notifications = [];
	const confirmations = [];
	let customSteps = [];
	let editedCommand = false;
	const plainTheme = {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
	};
	const keybindings = {
		matches: (data, action) =>
			(action === "tui.select.up" && data === "UP") ||
			(action === "tui.select.down" && data === "DOWN") ||
			(action === "tui.select.confirm" && data === "ENTER") ||
			(action === "tui.select.cancel" && data === "ESC"),
	};
	const panelAction = (key) => async (factory) =>
		new Promise((resolve) => {
			const panel = factory(
				{ terminal: { rows: 80 }, requestRender() {} },
				plainTheme,
				keybindings,
				resolve,
			);
			panel.render(120);
			panel.handleInput(key);
		});
	const closePanel = async () => ({ action: "close", cursor: { tabId: "all" } });
	const ctx = {
		mode: "tui",
		cwd: projectRoot,
		isProjectTrusted: () => true,
		ui: {
			async custom(factory) {
				const step = customSteps.shift();
				assert.ok(step, "unexpected extra /mcp panel render");
				return step(factory);
			},
			async select(title, options) {
				if (title === "Write to Agent configuration") {
					return options.find((option) => option.startsWith("Global"));
				}
				if (title === "MCP transport") return options.find((option) => option.startsWith("stdio"));
				if (title.startsWith("Edit Pi /")) return "Command and arguments";
				throw new Error(`Unexpected select prompt: ${title}`);
			},
			async input(title) {
				if (title === "MCP server name") return "through-command";
				if (title === "Server command") return process.execPath;
				if (title === "Arguments") return JSON.stringify([stdioServerPath]);
				if (title === "Environment") return "{}";
				if (title === "Command and arguments") {
					editedCommand = true;
					return JSON.stringify([process.execPath, stdioServerPath, "--edited"]);
				}
				throw new Error(`Unexpected input prompt: ${title}`);
			},
			async confirm(title, details) {
				confirmations.push({ title, details });
				return true;
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus() {},
		},
	};
	await handlers.get("session_start")({}, ctx);
	const command = commands.get("mcp");
	assert.ok(command);
	t.after(async () => handlers.get("session_shutdown")());

	customSteps = [
		async () => ({ action: "add", agentId: "pi", cursor: { tabId: "pi" } }),
		closePanel,
	];
	await command.handler("", ctx);
	const piPath = join(home, ".pi", "agent", "mcp.json");
	assert.deepEqual(JSON.parse(readFileSync(piPath, "utf8")).mcpServers["through-command"].args, [
		stdioServerPath,
	]);

	customSteps = [panelAction("e"), closePanel];
	await command.handler("", ctx);
	assert.equal(editedCommand, true);
	assert.deepEqual(JSON.parse(readFileSync(piPath, "utf8")).mcpServers["through-command"].args, [
		stdioServerPath,
		"--edited",
	]);

	customSteps = [panelAction("c"), closePanel];
	await command.handler("", ctx);
	const connectedTool = activeTools.find((name) => name !== "native-tool");
	assert.ok(connectedTool);
	assert.equal(registeredTools.has(connectedTool), true);
	const toolResult = await registeredTools.get(connectedTool).execute(
		"command-integration-call",
		{ text: "from-command" },
		new AbortController().signal,
		() => undefined,
		{},
	);
	assert.equal(toolResult.content[0].text, "echo:from-command");

	customSteps = [panelAction("c"), closePanel];
	await command.handler("", ctx);
	assert.deepEqual(activeTools, ["native-tool"]);

	customSteps = [panelAction("d"), closePanel];
	await command.handler("", ctx);
	assert.deepEqual(JSON.parse(readFileSync(piPath, "utf8")), { mcpServers: {} });
	assert.deepEqual(
		confirmations.map((confirmation) => confirmation.title),
		["Add MCP server?", "Update MCP server?", "Delete MCP server?"],
	);
	assert.equal(confirmations.every((confirmation) => confirmation.details.includes("through-command")), true);
	assert.equal(notifications.some(({ message }) => message.startsWith("Connected Pi / through-command")), true);
	assert.equal(notifications.some(({ message }) => message.startsWith("Disconnected Pi / through-command")), true);
});
