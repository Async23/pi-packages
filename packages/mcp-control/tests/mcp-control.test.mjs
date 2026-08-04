import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import mcpControlExtension from "../extensions/index.ts";
import {
	AGENT_SOURCES,
	ConcurrentConfigChangeError,
	ConfigMutationCoordinator,
	McpControl,
	McpControlPanel,
	McpRuntimeManager,
	MemoryConfigFileStore,
	NodeConfigFileStore,
	UnsafeConfigPathError,
	adaptToolResult,
	discoverCatalog,
	jsoncCodec,
	parseTomlDottedKey,
	piToolName,
	tomlCodec,
} from "../extensions/index.ts";

const home = "/virtual/home";
const projectRoot = "/virtual/project";

function setup(files) {
	const store = new MemoryConfigFileStore(files);
	const existing = new Set([...Object.keys(files), join(projectRoot, ".git")]);
	const options = {
		cwd: projectRoot,
		home,
		projectRoot,
		platform: "darwin",
		pathExists: (path) => existing.has(path),
	};
	return { store, options };
}

test("Agent tabs match pi-skill-control order and keep unsupported sources visible", () => {
	assert.deepEqual(
		AGENT_SOURCES.map((agent) => agent.label),
		[
			".agents",
			"Pi",
			"Claude",
			"Codex",
			"OpenCode",
			"Gemini",
			"Antigravity",
			"Cursor",
			"Trae",
			"Grok",
			"Kimi Code",
			"Zed",
		],
	);
});

test("same-name servers remain separate by Agent and preserve within-Agent resolution", () => {
	const claudeUser = join(home, ".claude.json");
	const claudeProject = join(projectRoot, ".mcp.json");
	const codexUser = join(home, ".codex", "config.toml");
	const codexProject = join(projectRoot, ".codex", "config.toml");
	const { store, options } = setup({
		[claudeUser]: '{"mcpServers":{"shared":{"command":"user-command"}}}\n',
		[claudeProject]: '{"mcpServers":{"shared":{"command":"project-command"}}}\n',
		[codexUser]: '[mcp_servers.shared]\ncommand = "codex-user"\n[mcp_servers.shared.env]\nTOKEN = "secret"\n',
		[codexProject]: '[mcp_servers.shared]\nenabled = false\n',
	});
	const catalog = discoverCatalog(store, options);
	const shared = catalog.entries.filter((entry) => entry.serverName === "shared");
	assert.equal(shared.length, 4);
	assert.equal(new Set(shared.map((entry) => entry.id)).size, 4);

	const claude = shared.filter((entry) => entry.agentId === "claude");
	assert.equal(claude.find((entry) => entry.source.path === claudeUser)?.resolution, "shadowed");
	assert.equal(claude.find((entry) => entry.source.path === claudeProject)?.resolution, "active");

	const codex = shared.filter((entry) => entry.agentId === "codex");
	assert.equal(codex.find((entry) => entry.source.path === codexUser)?.resolution, "contributes");
	const effective = codex.find((entry) => entry.source.path === codexProject);
	assert.equal(effective?.resolution, "disabled");
	assert.equal(effective?.effectiveConfig.command, "codex-user");
	assert.equal(effective?.effectiveConfig.enabled, false);
	assert.equal(effective?.originChain.length, 2);
});

test("project MCP files are not read or writable before Pi trusts the project", async () => {
	const projectConfig = join(projectRoot, ".pi", "mcp.json");
	const { store, options } = setup({
		[projectConfig]: '{"mcpServers":{"project-only":{"command":"node"}}}\n',
	});
	const control = new McpControl({ ...options, fileStore: store, includeProjectSources: false });
	let snapshot = control.snapshot();
	assert.equal(snapshot.entries.some((entry) => entry.serverName === "project-only"), false);
	const source = snapshot.sources.find((candidate) => candidate.path === projectConfig);
	assert.equal(source?.writable, false);
	assert.match(source?.readOnlyReason ?? "", /trusted/);

	const refreshed = await control.execute({ type: "refresh", includeProjectSources: true });
	assert.equal(refreshed.type, "snapshot");
	snapshot = refreshed.snapshot;
	assert.equal(snapshot.entries.some((entry) => entry.serverName === "project-only"), true);
	assert.equal(snapshot.sources.find((candidate) => candidate.path === projectConfig)?.writable, true);
});

test("public snapshot masks secrets, argument values, URL credentials, and query strings", () => {
	const piConfig = join(home, ".pi", "agent", "mcp.json");
	const { store, options } = setup({
		[piConfig]: JSON.stringify({
			mcpServers: {
				secure: {
					url: "https://user:password@example.com/mcp?token=secret#fragment",
					headers: { Authorization: "Bearer secret", "X-Name": "also-secret" },
					env: { API_KEY: "secret" },
					args: ["--token", "secret"],
				},
			},
		}),
	});
	const control = new McpControl({ ...options, fileStore: store });
	const entry = control.snapshot().entries.find((candidate) => candidate.serverName === "secure");
	assert.ok(entry);
	const serialized = JSON.stringify(entry);
	assert.doesNotMatch(serialized, /password|Bearer secret|also-secret|API_KEY":"secret|--token|fragment/);
	assert.match(serialized, /<redacted>/);
	assert.equal(entry.normalized.url, "https://example.com/mcp");
	assert.deepEqual(entry.normalized.headerNames, ["Authorization", "X-Name"]);
});

test("JSONC upsert preserves surrounding comments and unrelated fields", () => {
	const before = `{
  // keep this comment
  "other": { "unknown": true },
  "mcpServers": {
    "old": { "command": "node", "custom": 42 }
  }
}
`;
	const after = jsoncCodec.upsertServer(before, ["mcpServers"], "old", {
		command: "bun",
		custom: 42,
	});
	assert.match(after, /\/\/ keep this comment/);
	assert.match(after, /"other": \{ "unknown": true \}/);
	assert.match(after, /"command": "bun"/);
	assert.match(after, /"custom": 42/);
});

test("Codex TOML replacement targets quoted server tables and preserves unrelated text", () => {
	const before = `# global comment
model = "gpt"

[mcp_servers."foo.bar"]
command = "old"

[mcp_servers."foo.bar".env]
TOKEN = "secret"

# keep beta
[mcp_servers.beta]
command = "beta"
`;
	assert.deepEqual(parseTomlDottedKey('mcp_servers."foo.bar".env'), ["mcp_servers", "foo.bar", "env"]);
	const after = tomlCodec.upsertServer(before, ["mcp_servers"], "foo.bar", {
		command: "new",
		env: { TOKEN: "secret" },
	});
	assert.match(after, /# global comment/);
	assert.match(after, /# keep beta/);
	assert.match(after, /\[mcp_servers\.beta\]\ncommand = "beta"/);
	assert.match(after, /\[mcp_servers\."foo\.bar"\]\ncommand = "new"/);
	assert.equal(tomlCodec.parseDocument(after, ["mcp_servers"]).serverMap["foo.bar"].command, "new");
});

test("patch planning preserves hidden fields and commit creates a backup", async () => {
	const piConfig = join(home, ".pi", "agent", "mcp.json");
	const before = `{
  // secret must survive a safe field patch
  "mcpServers": {
    "alpha": { "command": "node", "env": { "TOKEN": "secret" }, "unknown": 7 }
  }
}
`;
	const { store, options } = setup({ [piConfig]: before });
	const control = new McpControl({ ...options, fileStore: store });
	const entry = control.snapshot().entries.find((candidate) => candidate.serverName === "alpha");
	assert.ok(entry);
	const planned = await control.execute({ type: "plan-patch", entryId: entry.id, patch: { enabled: false } });
	assert.equal(planned.type, "plan");
	assert.doesNotMatch(planned.plan.diff, /secret/);
	const committed = await control.execute({ type: "commit", planId: planned.plan.id });
	assert.equal(committed.type, "committed");
	assert.ok(committed.result.backupPath);
	const content = store.read(piConfig).content;
	assert.match(content, /secret must survive/);
	assert.match(content, /"TOKEN": "secret"/);
	assert.match(content, /"unknown": 7/);
	assert.match(content, /"enabled": false/);
	assert.equal(store.backups.get(committed.result.backupPath), before);
});

test("control can create and then delete a server in the selected Agent source", async () => {
	const { store, options } = setup({});
	const control = new McpControl({ ...options, fileStore: store });
	const source = control
		.snapshot()
		.sources.find((candidate) => candidate.agentId === "pi" && candidate.level === "project");
	assert.ok(source);
	const addedPlan = await control.execute({
		type: "plan-upsert",
		sourceId: source.id,
		serverName: "fresh",
		config: { command: "node", args: ["server.js"] },
	});
	assert.equal(addedPlan.type, "plan");
	assert.equal(addedPlan.plan.createsFile, true);
	await control.execute({ type: "commit", planId: addedPlan.plan.id });
	let entry = control.snapshot().entries.find((candidate) => candidate.serverName === "fresh");
	assert.ok(entry);
	assert.equal(entry.agentId, "pi");

	const deletePlan = await control.execute({ type: "plan-delete", entryId: entry.id });
	assert.equal(deletePlan.type, "plan");
	await control.execute({ type: "commit", planId: deletePlan.plan.id });
	entry = control.snapshot().entries.find((candidate) => candidate.serverName === "fresh");
	assert.equal(entry, undefined);
	assert.deepEqual(JSON.parse(store.read(join(projectRoot, ".pi", "mcp.json")).content), { mcpServers: {} });
});

test("commit rejects a concurrent file change after preview", () => {
	const path = join(home, ".pi", "agent", "mcp.json");
	const original = '{"mcpServers":{"alpha":{"command":"node"}}}\n';
	const { store, options } = setup({ [path]: original });
	const catalog = discoverCatalog(store, options);
	const coordinator = new ConfigMutationCoordinator(store);
	const entry = catalog.entries.find((candidate) => candidate.serverName === "alpha");
	assert.ok(entry);
	const plan = coordinator.planPatch(catalog, entry.id, { enabled: false });
	store.set(path, `${original.trim()} \n`);
	assert.throws(() => coordinator.commit(plan.id), ConcurrentConfigChangeError);
});

test("real file writes are atomic, backed up, permission-restricted, and reject symlinks", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mcp-control-"));
	try {
		const store = new NodeConfigFileStore();
		const existingPath = join(directory, "existing.json");
		writeFileSync(existingPath, "before\n", { encoding: "utf8", mode: 0o600 });
		const before = store.read(existingPath);
		const updated = store.writeAtomic({ path: existingPath, content: "after\n", expectedHash: before.hash });
		assert.equal(readFileSync(existingPath, "utf8"), "after\n");
		assert.equal(readFileSync(updated.backupPath, "utf8"), "before\n");

		const createdPath = join(directory, "nested", "new.json");
		store.writeAtomic({ path: createdPath, content: "{}\n", expectedHash: null });
		assert.equal(statSync(createdPath).mode & 0o777, 0o600);

		const symlinkPath = join(directory, "linked.json");
		symlinkSync(existingPath, symlinkPath);
		assert.throws(() => store.read(symlinkPath), UnsafeConfigPathError);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("runtime loads every primitive and keeps tool-level errors as results", async () => {
	const calls = [];
	const client = {
		async connect() {},
		async close() {},
		async listTools() {
			return { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] };
		},
		async listResources() {
			return { resources: [{ uri: "memory://one", name: "one" }] };
		},
		async listResourceTemplates() {
			return { resourceTemplates: [{ uriTemplate: "memory://{id}", name: "memory" }] };
		},
		async listPrompts() {
			return { prompts: [{ name: "review" }] };
		},
		async callTool(params) {
			calls.push(params);
			return { content: [{ type: "text", text: "bad input" }], isError: true };
		},
		async readResource() {
			return { contents: [] };
		},
		async getPrompt() {
			return { messages: [] };
		},
	};
	const runtime = new McpRuntimeManager({
		createClient: () => client,
		createTransport: () => ({ async start() {}, async send() {}, async close() {} }),
	});
	const definition = {
		instanceId: "instance-1",
		entryId: "entry-1",
		agentId: "claude",
		agentLabel: "Claude",
		serverName: "shared",
		config: { command: "fake" },
		flavor: "generic",
		cwd: projectRoot,
	};
	const connected = await runtime.connect(definition);
	assert.deepEqual(
		[connected.toolCount, connected.resourceCount, connected.resourceTemplateCount, connected.promptCount],
		[1, 1, 1, 1],
	);
	const result = adaptToolResult(await runtime.callTool("instance-1", "search", { query: "x" }));
	assert.equal(result.details.mcpIsError, true);
	assert.match(result.content[0].text, /execution error/);
	assert.deepEqual(calls, [{ name: "search", arguments: { query: "x" } }]);
	assert.match(piToolName(definition, "search"), /^mcp_claude_shared_search_/);
	await runtime.disconnectAll();
});

const plainTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

test("panel shows zero-count Agent tabs but source cycling skips them", () => {
	const piConfig = join(home, ".pi", "agent", "mcp.json");
	const cursorConfig = join(home, ".cursor", "mcp.json");
	const { store, options } = setup({
		[piConfig]: '{"mcpServers":{"same":{"command":"pi"}}}\n',
		[cursorConfig]: '{"mcpServers":{"same":{"command":"cursor"}}}\n',
	});
	const control = new McpControl({ ...options, fileStore: store });
	let result;
	const panel = new McpControlPanel({
		tui: { terminal: { rows: 80 }, requestRender() {} },
		theme: plainTheme,
		keybindings: {
			matches: (data, action) =>
				(action === "tui.select.up" && data === "UP") ||
				(action === "tui.select.down" && data === "DOWN") ||
				(action === "tui.select.confirm" && data === "ENTER") ||
				(action === "tui.select.cancel" && data === "ESC"),
		},
		snapshot: control.snapshot(),
		onDone(value) {
			result = value;
		},
	});
	const output = panel.render(120).join("\n");
	assert.equal(output.match(/\bAgents\b/g)?.length ?? 0, 1);
	for (const expected of ["[ALL 2]", "Pi 1", "Cursor 1", "Claude 0", "Trae 0", "Grok 0", "Kimi Code 0", "Zed 0"]) {
		assert.ok(output.includes(expected), `missing tab: ${expected}`);
	}
	assert.match(output, /Pi \(1\)[\s\S]*same[\s\S]*Cursor \(1\)[\s\S]*same/);
	for (const width of [36, 72, 120]) {
		for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${line}`);
	}
	for (const expected of ["Pi 1", "Cursor 1", "ALL 2"]) {
		panel.handleInput("]");
		assert.match(panel.render(120).join("\n"), new RegExp(`\\[${expected}\\]`));
	}
	panel.handleInput("[");
	assert.match(panel.render(120).join("\n"), /\[Cursor 1\]/);
	panel.handleInput("]");
	panel.render(120);
	panel.handleInput("ENTER");
	assert.equal(result.action, "connect");
	assert.equal(result.entryId, control.snapshot().entries[0].id);
});

test("j/k keep the current Agent heading visible while moving one MCP entry at a time", () => {
	const piConfig = join(home, ".pi", "agent", "mcp.json");
	const codexConfig = join(home, ".codex", "config.toml");
	const piServers = Object.fromEntries(
		Array.from({ length: 8 }, (_, index) => [`pi-${index}`, { command: `pi-${index}` }]),
	);
	const codexServers = Array.from(
		{ length: 8 },
		(_, index) => `[mcp_servers.codex-${index}]\ncommand = "codex-${index}"\n`,
	).join("\n");
	const { store, options } = setup({
		[piConfig]: `${JSON.stringify({ mcpServers: piServers })}\n`,
		[codexConfig]: codexServers,
	});
	const control = new McpControl({ ...options, fileStore: store });
	const panel = new McpControlPanel({
		tui: { terminal: { rows: 18 }, requestRender() {} },
		theme: plainTheme,
		keybindings: {
			matches: (data, action) =>
				(action === "tui.select.up" && data === "UP") ||
				(action === "tui.select.down" && data === "DOWN") ||
				(action === "tui.select.confirm" && data === "ENTER") ||
				(action === "tui.select.cancel" && data === "ESC"),
		},
		snapshot: control.snapshot(),
		onDone() {},
	});

	panel.render(120);
	for (let index = 0; index < 7; index++) panel.handleInput("j");
	assert.match(panel.render(120).join("\n"), /Pi \/ pi-7/);
	panel.handleInput("j");
	assert.match(panel.render(120).join("\n"), /Codex \/ codex-0/);
	panel.handleInput("k");
	assert.match(panel.render(120).join("\n"), /Pi \/ pi-7/);
	for (let index = 0; index < 4; index++) panel.handleInput("j");

	let output = panel.render(120).join("\n");
	assert.match(output, /Codex \/ codex-3/);
	assert.match(output, /Codex \(8\)/);
	panel.handleInput("k");
	output = panel.render(120).join("\n");
	assert.match(output, /Codex \/ codex-2/);
	assert.match(output, /Codex \(8\)/);
});

test("h/l switch panes so j/k select MCP entries or scroll details like pi-skill-control", () => {
	const piConfig = join(home, ".pi", "agent", "mcp.json");
	const metadata = Object.fromEntries(
		Array.from({ length: 30 }, (_, index) => [`line_${index}`, `value-${index}`]),
	);
	const { store, options } = setup({
		[piConfig]: `${JSON.stringify({
			mcpServers: {
				first: { command: "first", metadata },
				second: { command: "second" },
			},
		})}\n`,
	});
	const control = new McpControl({ ...options, fileStore: store });
	const panel = new McpControlPanel({
		tui: { terminal: { rows: 24 }, requestRender() {} },
		theme: plainTheme,
		keybindings: {
			matches: (data, action) =>
				(action === "tui.select.up" && data === "UP") ||
				(action === "tui.select.down" && data === "DOWN") ||
				(action === "tui.select.pageUp" && data === "PAGE_UP") ||
				(action === "tui.select.pageDown" && data === "PAGE_DOWN") ||
				(action === "tui.select.confirm" && data === "ENTER") ||
				(action === "tui.select.cancel" && data === "ESC"),
		},
		snapshot: control.snapshot(),
		onDone() {},
	});

	let output = panel.render(120).join("\n");
	assert.match(output, /Pi \/ first/);
	assert.match(output, /j\/k select\s+h\/l focus/);
	panel.handleInput("l");
	output = panel.render(120).join("\n");
	assert.match(output, /j\/k\/PgUp\/PgDn scroll\s+h\/l focus/);
	const beforeScroll = output;
	panel.handleInput("j");
	output = panel.render(120).join("\n");
	assert.notEqual(output, beforeScroll);
	assert.doesNotMatch(output, /Pi \/ second/);
	panel.handleInput("h");
	panel.handleInput("j");
	output = panel.render(120).join("\n");
	assert.match(output, /Pi \/ second/);
	assert.match(output, /j\/k select\s+h\/l focus/);
});

test("j/k wrap between the first and last MCP entries without stopping on Agent headings", () => {
	const piConfig = join(home, ".pi", "agent", "mcp.json");
	const cursorConfig = join(home, ".cursor", "mcp.json");
	const { store, options } = setup({
		[piConfig]: '{"mcpServers":{"first":{"command":"first"}}}\n',
		[cursorConfig]: '{"mcpServers":{"last":{"command":"last"}}}\n',
	});
	const control = new McpControl({ ...options, fileStore: store });
	const panel = new McpControlPanel({
		tui: { terminal: { rows: 24 }, requestRender() {} },
		theme: plainTheme,
		keybindings: {
			matches: (data, action) =>
				(action === "tui.select.up" && data === "UP") ||
				(action === "tui.select.down" && data === "DOWN") ||
				(action === "tui.select.confirm" && data === "ENTER") ||
				(action === "tui.select.cancel" && data === "ESC"),
		},
		snapshot: control.snapshot(),
		onDone() {},
	});

	assert.match(panel.render(120).join("\n"), /Pi \/ first/);
	panel.handleInput("k");
	assert.match(panel.render(120).join("\n"), /Cursor \/ last/);
	panel.handleInput("j");
	assert.match(panel.render(120).join("\n"), /Pi \/ first/);
});

test("default export registers /mcp without connecting any server", async () => {
	const handlers = new Map();
	const commands = new Map();
	const registeredTools = [];
	let activeTools = [];
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerTool(tool) {
			registeredTools.push(tool);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names) {
			activeTools = [...names];
		},
		sendUserMessage() {},
	};
	mcpControlExtension(pi);
	assert.ok(commands.has("mcp"));
	assert.equal(registeredTools.length, 0);
	assert.ok(handlers.has("session_start"));
	assert.ok(handlers.has("session_shutdown"));
	await handlers.get("session_shutdown")();
});
