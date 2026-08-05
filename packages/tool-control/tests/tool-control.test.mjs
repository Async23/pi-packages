import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

import toolControlExtension, { ToolControlPanel } from "../extensions/index.ts";
import {
	MCP_TOOL_INVENTORY_PROTOCOL,
	MCP_TOOL_INVENTORY_REQUEST_CHANNEL,
	MCP_TOOL_INVENTORY_SNAPSHOT_CHANNEL,
	MCP_TOOL_INVENTORY_VERSION,
	McpToolInventoryClient,
	parseMcpToolInventorySnapshot,
} from "../extensions/inventory-protocol.ts";
import {
	TOOL_SELECTION_ENTRY_TYPE,
	ToolSelectionController,
	buildToolCatalog,
	decodeToolSelectionEntry,
	restoreInactiveToolNames,
} from "../extensions/policy.ts";

function sourceInfo(path, source = "local") {
	return { path, source, scope: "temporary", origin: "top-level" };
}

function tool(name, options = {}) {
	return {
		name,
		description: options.description ?? `${name} description`,
		parameters: options.parameters ?? { type: "object", properties: {} },
		promptGuidelines: options.promptGuidelines,
		sourceInfo: options.sourceInfo ?? sourceInfo(`<builtin:${name}>`, "builtin"),
	};
}

function customEntry(data, overrides = {}) {
	return {
		type: "custom",
		id: overrides.id ?? crypto.randomUUID(),
		parentId: overrides.parentId ?? null,
		timestamp: overrides.timestamp ?? new Date().toISOString(),
		customType: overrides.customType ?? TOOL_SELECTION_ENTRY_TYPE,
		data,
	};
}

function inventorySnapshot(tools, generation = 1) {
	return {
		protocol: MCP_TOOL_INVENTORY_PROTOCOL,
		version: MCP_TOOL_INVENTORY_VERSION,
		generation,
		tools,
	};
}

function inventoryItem(toolName, overrides = {}) {
	return {
		toolName,
		available: overrides.available ?? true,
		source: {
			instanceId: overrides.instanceId ?? "instance-1",
			agentId: overrides.agentId ?? "pi",
			agentLabel: overrides.agentLabel ?? "Pi",
			serverName: overrides.serverName ?? "chrome-devtools",
			primitiveKind: overrides.primitiveKind ?? "tool",
			remoteName: overrides.remoteName ?? toolName,
		},
	};
}

const plainTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

const keybindings = {
	matches: (data, action) =>
		(action === "tui.select.up" && data === "UP") ||
		(action === "tui.select.down" && data === "DOWN") ||
		(action === "tui.select.pageUp" && data === "PAGE_UP") ||
		(action === "tui.select.pageDown" && data === "PAGE_DOWN") ||
		(action === "tui.select.confirm" && data === "ENTER") ||
		(action === "tui.select.cancel" && data === "ESC"),
};

function terminalText(text) {
	return text.replaceAll(CURSOR_MARKER, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function panelItems() {
	const mcpClick = "mcp_pi_chrome_click_12345678";
	const mcpSearch = "mcp_pi_chrome_search_12345678";
	const tools = [
		tool("read", { description: "Read files", promptGuidelines: ["Prefer narrow reads"] }),
		tool("write", { description: "Write files" }),
		tool(mcpClick, { description: "Click a page", sourceInfo: sourceInfo("/repo/packages/mcp-control/extensions/index.ts") }),
		tool(mcpSearch, { description: "Search a page", sourceInfo: sourceInfo("/repo/packages/mcp-control/extensions/index.ts") }),
		tool("notify", { sourceInfo: sourceInfo("/repo/packages/notify/extensions/index.ts") }),
		tool("sdk_question", { sourceInfo: sourceInfo("<sdk:sdk_question>", "sdk") }),
	];
	const snapshot = inventorySnapshot([
		inventoryItem(mcpClick, { remoteName: "click" }),
		inventoryItem(mcpSearch, { remoteName: "search" }),
	]);
	return buildToolCatalog(tools, snapshot);
}

function makePanel(options = {}) {
	const items = options.items ?? panelItems();
	const inactive = options.inactiveToolNames ?? new Set(["write"]);
	const active = options.activeToolNames ?? new Set(items.map((item) => item.name).filter((name) => !inactive.has(name)));
	let applied;
	const panel = new ToolControlPanel({
		tui: { terminal: { rows: options.rows ?? 80 }, requestRender() {} },
		theme: options.theme ?? plainTheme,
		keybindings,
		items,
		activeToolNames: active,
		inactiveToolNames: inactive,
		onApply: options.onApply ?? ((nextInactive) => {
			applied = new Set(nextInactive);
			return {
				items,
				inactiveToolNames: nextInactive,
				activeToolNames: new Set(items.map((item) => item.name).filter((name) => !nextInactive.has(name))),
			};
		}),
		onDone: options.onDone ?? (() => undefined),
	});
	panel.focused = true;
	return { panel, getApplied: () => applied };
}

function widePane(panel, column) {
	return terminalText(
		panel
			.render(120)
			.flatMap((line) => {
				const columns = line.split("│");
				return columns.length >= 4 ? [columns[column]] : [];
			})
			.join("\n"),
	);
}

function wideList(panel) {
	return widePane(panel, 1);
}

class FakeRuntime {
	constructor(tools, active = tools.map((item) => item.name)) {
		this.tools = tools;
		this.active = active;
		this.entries = [];
		this.setCalls = [];
	}

	getAllTools() {
		return this.tools;
	}

	getActiveTools() {
		return [...this.active];
	}

	setActiveTools(names) {
		this.active = [...names];
		this.setCalls.push([...names]);
	}

	appendEntry(customType, data) {
		this.entries.push({ customType, data });
	}
}

test("selection entries are full snapshots and the latest valid branch entry wins", () => {
	const branch = [
		customEntry({ version: 1, inactiveToolNames: ["write", "read", "write"] }),
		customEntry({ version: 999, inactiveToolNames: ["ignored"] }),
		customEntry({ version: 1, inactiveToolNames: ["bash"] }),
	];
	assert.deepEqual([...restoreInactiveToolNames(branch)], ["bash"]);
	assert.deepEqual(decodeToolSelectionEntry({ version: 1, inactiveToolNames: ["write", "read", "write"] }), {
		version: 1,
		inactiveToolNames: ["read", "write"],
	});
});

test("forked branches inherit the snapshot at the fork point and then diverge", () => {
	const inherited = customEntry({ version: 1, inactiveToolNames: ["write"] }, { id: "policy-parent" });
	const left = [inherited, customEntry({ version: 1, inactiveToolNames: ["write", "bash"] }, { id: "left" })];
	const right = [inherited, customEntry({ version: 1, inactiveToolNames: [] }, { id: "right" })];
	assert.deepEqual([...restoreInactiveToolNames(left)].sort(), ["bash", "write"]);
	assert.deepEqual([...restoreInactiveToolNames(right)], []);
});

test("a branch without a selection preserves Pi's initial active Tools", () => {
	const tools = [tool("read"), tool("bash"), tool("edit"), tool("write"), tool("grep"), tool("find"), tool("ls")];
	const runtime = new FakeRuntime(tools, ["read", "bash", "edit", "write"]);
	const controller = new ToolSelectionController(runtime);

	const result = controller.restore([]);

	assert.deepEqual(result.activeToolNames, ["read", "bash", "edit", "write"]);
	assert.deepEqual([...result.inactiveToolNames], ["grep", "find", "ls"]);
	assert.deepEqual(runtime.entries, []);
});

test("an explicitly saved empty inactive set still activates every registered Tool", () => {
	const tools = [tool("read"), tool("grep")];
	const runtime = new FakeRuntime(tools, ["read"]);
	const controller = new ToolSelectionController(runtime);

	const result = controller.restore([customEntry({ version: 1, inactiveToolNames: [] })]);

	assert.deepEqual(result.activeToolNames, ["read", "grep"]);
	assert.deepEqual([...result.inactiveToolNames], []);
});

test("a branch without a selection reuses the initial baseline after visiting another branch", () => {
	const tools = [tool("read"), tool("write")];
	const runtime = new FakeRuntime(tools, ["read"]);
	const controller = new ToolSelectionController(runtime);

	controller.restore([]);
	controller.restore([customEntry({ version: 1, inactiveToolNames: ["read"] })]);
	assert.deepEqual(runtime.active, ["write"]);

	controller.restore([]);
	assert.deepEqual(runtime.active, ["read"]);
});

test("controller defaults new registered Tools active and persists only inactive names", () => {
	const runtime = new FakeRuntime([tool("read"), tool("write")]);
	const controller = new ToolSelectionController(runtime);
	controller.restore([customEntry({ version: 1, inactiveToolNames: ["write"] })]);
	assert.deepEqual(runtime.active, ["read"]);

	runtime.tools.push(tool("search"));
	controller.reconcile();
	assert.deepEqual(runtime.active, ["read", "search"]);

	controller.apply(new Set(["read"]));
	assert.deepEqual(runtime.active, ["write", "search"]);
	assert.deepEqual(runtime.entries.at(-1), {
		customType: TOOL_SELECTION_ENTRY_TYPE,
		data: { version: 1, inactiveToolNames: ["read"] },
	});
});

test("current selection observes Pi's active Tools without reapplying the saved branch selection", () => {
	const runtime = new FakeRuntime([tool("read"), tool("write")]);
	const controller = new ToolSelectionController(runtime);
	controller.restore([customEntry({ version: 1, inactiveToolNames: ["write"] })]);
	runtime.setCalls.length = 0;
	runtime.active = ["write"];

	const current = controller.currentSelection();

	assert.deepEqual([...current.activeToolNames], ["write"]);
	assert.deepEqual([...current.inactiveToolNames], ["read"]);
	assert.deepEqual(current.items.map((item) => item.name), ["read", "write"]);
	assert.deepEqual(runtime.setCalls, []);
});

test("reconciliation preserves inactive preferences for temporarily missing Tools", () => {
	const runtime = new FakeRuntime([tool("read"), tool("write")]);
	const controller = new ToolSelectionController(runtime);
	controller.restore([customEntry({ version: 1, inactiveToolNames: ["write"] })]);
	runtime.entries.length = 0;
	runtime.tools = [tool("read")];

	const result = controller.reconcile();
	assert.deepEqual(result.activeToolNames, ["read"]);
	assert.deepEqual([...result.inactiveToolNames], ["write"]);
	assert.deepEqual(runtime.entries, []);
});

test("applying visible changes preserves inactive preferences for unavailable MCP Tools", () => {
	const mcpName = "mcp_pi_chrome_click_12345678";
	const runtime = new FakeRuntime([tool("read"), tool(mcpName)]);
	const snapshot = inventorySnapshot([inventoryItem(mcpName, { available: false, remoteName: "click" })]);
	const controller = new ToolSelectionController(runtime, () => snapshot);
	controller.restore([customEntry({ version: 1, inactiveToolNames: [mcpName] })]);
	runtime.entries.length = 0;

	controller.apply(new Set(["read"]));

	assert.deepEqual(runtime.active, []);
	assert.deepEqual(runtime.entries.at(-1), {
		customType: TOOL_SELECTION_ENTRY_TYPE,
		data: { version: 1, inactiveToolNames: [mcpName, "read"] },
	});
});

test("failed apply keeps the controller baseline unchanged so a retry can persist", () => {
	const runtime = new FakeRuntime([tool("read"), tool("write")]);
	const controller = new ToolSelectionController(runtime);
	controller.restore([]);
	const setActiveTools = runtime.setActiveTools.bind(runtime);
	let fail = true;
	runtime.setActiveTools = (names) => {
		if (fail) throw new Error("set failed");
		setActiveTools(names);
	};
	assert.throws(() => controller.apply(new Set(["write"])), /set failed/);
	assert.deepEqual(runtime.entries, []);

	fail = false;
	controller.apply(new Set(["write"]));
	assert.deepEqual(runtime.entries.at(-1).data.inactiveToolNames, ["write"]);
});

test("MCP inactive preferences survive disconnect and are re-applied after reconnect", () => {
	const mcpName = "mcp_pi_chrome_click_12345678";
	const runtime = new FakeRuntime([tool("read"), tool(mcpName, { sourceInfo: sourceInfo("/mcp-control/index.ts") })]);
	let snapshot = inventorySnapshot([inventoryItem(mcpName, { available: true, remoteName: "click" })]);
	const controller = new ToolSelectionController(runtime, () => snapshot);
	controller.restore([customEntry({ version: 1, inactiveToolNames: [mcpName] })]);
	runtime.entries.length = 0;

	snapshot = inventorySnapshot([inventoryItem(mcpName, { available: false, remoteName: "click" })], 2);
	const result = controller.reconcile();
	assert.deepEqual(result.activeToolNames, ["read"]);
	assert.deepEqual([...result.inactiveToolNames], [mcpName]);
	assert.deepEqual(runtime.entries, []);

	runtime.active = ["read", mcpName];
	snapshot = inventorySnapshot([inventoryItem(mcpName, { available: true, remoteName: "click" })], 3);
	assert.deepEqual(controller.applyMcpPreferences(snapshot), [mcpName]);
	assert.deepEqual(runtime.active, ["read"]);
	assert.deepEqual(runtime.entries, []);
});

test("MCP preference application preserves non-MCP state and skips no-op writes", () => {
	const mcpName = "mcp_pi_chrome_click_12345678";
	const runtime = new FakeRuntime([tool("read"), tool("write"), tool(mcpName)]);
	const snapshot = inventorySnapshot([inventoryItem(mcpName, { remoteName: "click" })]);
	const controller = new ToolSelectionController(runtime, () => snapshot);
	controller.restore([customEntry({ version: 1, inactiveToolNames: [mcpName] })]);
	runtime.active = ["write", mcpName];
	runtime.setCalls.length = 0;

	assert.deepEqual(controller.applyMcpPreferences(snapshot), [mcpName]);
	assert.deepEqual(runtime.active, ["write"]);
	assert.deepEqual(runtime.setCalls, [["write"]]);

	assert.deepEqual(controller.applyMcpPreferences(snapshot), []);
	assert.deepEqual(runtime.setCalls, [["write"]]);
});

test("catalog classifies Built-in, MCP, Extension, and SDK sources and degrades without MCP metadata", () => {
	const mcpName = "mcp_pi_chrome_click_12345678";
	const tools = [
		tool("read"),
		tool(mcpName, { sourceInfo: sourceInfo("/repo/packages/mcp-control/extensions/index.ts") }),
		tool("notify", { sourceInfo: sourceInfo("/repo/packages/notify/extensions/index.ts") }),
		tool("sdk_tool", { sourceInfo: sourceInfo("<sdk:sdk_tool>", "sdk") }),
	];
	const snapshot = inventorySnapshot([inventoryItem(mcpName, { remoteName: "click" })]);
	const catalog = buildToolCatalog(tools, snapshot);
	assert.deepEqual(catalog.map((item) => item.sourceKind), ["builtin", "mcp", "extension", "sdk"]);
	assert.equal(catalog[1].groupLabel, "MCP · Pi / chrome-devtools");
	assert.equal(catalog[2].groupLabel, "Extension · notify");

	const degraded = buildToolCatalog(tools, undefined);
	assert.equal(degraded.find((item) => item.name === mcpName).sourceKind, "extension");
});

test("inventory protocol rejects malformed snapshots and the client requests and accepts v1 snapshots", () => {
	assert.equal(parseMcpToolInventorySnapshot({}), undefined);
	assert.equal(parseMcpToolInventorySnapshot(inventorySnapshot([inventoryItem("same"), inventoryItem("same")])), undefined);

	const handlers = new Map();
	const emitted = [];
	const events = {
		emit(channel, data) {
			emitted.push({ channel, data });
		},
		on(channel, handler) {
			handlers.set(channel, handler);
			return () => handlers.delete(channel);
		},
	};
	let received;
	const client = new McpToolInventoryClient(events, (snapshot) => {
		received = snapshot;
	});
	assert.equal(emitted[0].channel, MCP_TOOL_INVENTORY_REQUEST_CHANNEL);
	handlers.get(MCP_TOOL_INVENTORY_SNAPSHOT_CHANNEL)(inventorySnapshot([inventoryItem("search")], 7));
	assert.equal(received.generation, 7);
	assert.equal(client.snapshot().tools[0].toolName, "search");
	client.dispose();
	assert.equal(handlers.has(MCP_TOOL_INVENTORY_SNAPSHOT_CHANNEL), false);
});

test("panel renders source tabs, flat MCP grouping, uniform Tool indentation, and full details", () => {
	const { panel } = makePanel();
	const output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /Sources\s+\[ALL 6\]\s+Built-in 2\s+MCP 2\s+Extension 1\s+SDK 1/);
	assert.match(output, /▾ MCP · Pi \/ chrome-devtools \(2\)/);
	assert.match(output, /Name\s+read/);
	assert.match(output, /Description/);
	assert.match(output, /Parameters JSON Schema/);
	assert.match(output, /Prompt Guidelines/);

	const list = wideList(panel).split("\n");
	const readLine = list.find((line) => line.includes("read"));
	const writeLine = list.find((line) => line.includes("write"));
	assert.ok(readLine && writeLine);
	assert.equal(readLine.indexOf("read"), writeLine.indexOf("write"));
	assert.match(readLine, /^\s{5}● read/);
	assert.match(writeLine, /^\s{5}○ write/);
});

test("source tabs keep populated sources ahead of zero-count sources", () => {
	const items = panelItems().filter((item) => item.sourceKind === "builtin" || item.sourceKind === "extension");
	const { panel } = makePanel({ items });
	const output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /Sources\s+\[ALL 3\]\s+Built-in 2\s+Extension 1\s+MCP 0\s+SDK 0/);
});

test("Space stages an aligned transition and Ctrl+S applies all Pending changes without closing", () => {
	const { panel, getApplied } = makePanel();
	panel.render(120);
	panel.handleInput(" ");
	let output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /●→○ read/);
	assert.match(output, /△ 1/);
	panel.handleInput("\x13");
	output = terminalText(panel.render(120).join("\n"));
	assert.deepEqual([...getApplied()].sort(), ["read", "write"]);
	assert.doesNotMatch(output, /●→○/);
	assert.match(output, /Applied 1 Tool change/);
});

test("filter matches Tool Name only and group bulk actions affect only visible matches", () => {
	const { panel, getApplied } = makePanel({ inactiveToolNames: new Set() });
	panel.render(120);
	panel.handleInput("/");
	for (const character of "devtools") panel.handleInput(character);
	panel.handleInput("ENTER");
	let output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /No Tool Names match “devtools”/);

	panel.handleInput("ESC");
	panel.handleInput("/");
	for (const character of "click") panel.handleInput(character);
	panel.handleInput("ENTER");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /MCP · Pi \/ chrome-devtools \(1\/2\)/);
	assert.match(output, /mcp_pi_chrome_click_12345678/);
	assert.doesNotMatch(wideList(panel), /mcp_pi_chrome_search_12345678/);

	panel.handleInput("k");
	panel.handleInput("d");
	panel.handleInput("\x13");
	assert.deepEqual([...getApplied()], ["mcp_pi_chrome_click_12345678"]);
});

test("group folding is transient and selected rows use selectedBg only while the list is focused", () => {
	const selectedTheme = {
		...plainTheme,
		bg: (color, text) => color === "selectedBg" ? `<selected>${text}</selected>` : text,
	};
	const { panel } = makePanel({ theme: selectedTheme });
	panel.render(120);
	let output = panel.render(120).join("\n");
	assert.match(output, /<selected>[^\n]*read[^\n]*<\/selected>/);
	panel.handleInput("l");
	assert.doesNotMatch(panel.render(120).join("\n"), /<selected>/);
	panel.handleInput("h");
	panel.handleInput("k");
	panel.handleInput("ENTER");
	assert.doesNotMatch(wideList(panel), /\bread\b/);

	const fresh = makePanel().panel;
	assert.match(wideList(fresh), /\bread\b/);
});

test("wide and narrow panel layouts stay within the requested terminal width", () => {
	for (const width of [36, 48, 72, 91, 92, 120]) {
		const { panel } = makePanel();
		for (const line of panel.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)} cells: ${terminalText(line)}`);
		}
	}
});

test("extension restores branches, observes current state, and narrows Inventory updates to MCP preferences", async () => {
	const handlers = new Map();
	const commands = new Map();
	const busHandlers = new Map();
	const entries = [];
	const mcpName = "mcp_pi_chrome_click_12345678";
	const tools = [
		tool("read"),
		tool("write"),
		tool(mcpName, { sourceInfo: sourceInfo("/repo/packages/mcp-control/extensions/index.ts") }),
	];
	let active = tools.map((item) => item.name);
	const pi = {
		events: {
			emit(channel, data) {
				busHandlers.get(channel)?.(data);
			},
			on(channel, handler) {
				busHandlers.set(channel, handler);
				return () => busHandlers.delete(channel);
			},
		},
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		getAllTools() {
			return tools;
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names) {
			active = [...names];
		},
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
	};
	toolControlExtension(pi);
	assert.equal(commands.has("tools"), true);
	assert.equal(handlers.has("tool_call"), false);
	assert.equal(handlers.has("before_agent_start"), false);
	let openedPanel;
	const context = {
		mode: "tui",
		sessionManager: {
			getBranch: () => [customEntry({ version: 1, inactiveToolNames: ["write", mcpName] })],
		},
		ui: {
			notify() {},
			async custom(factory) {
				openedPanel = await factory(
					{ terminal: { rows: 80 }, requestRender() {} },
					plainTheme,
					keybindings,
					() => undefined,
				);
			},
		},
	};
	await handlers.get("session_start")[0]({ type: "session_start" }, context);
	assert.deepEqual(active, ["read"]);

	active = ["write", mcpName];
	pi.events.emit(
		MCP_TOOL_INVENTORY_SNAPSHOT_CHANNEL,
		inventorySnapshot([inventoryItem(mcpName, { remoteName: "click" })]),
	);
	assert.deepEqual(active, ["write"]);
	assert.deepEqual(entries, []);

	await commands.get("tools").handler("", context);
	assert.deepEqual(active, ["write"]);
	assert.match(wideList(openedPanel), /^\s{5}○ read/m);
	assert.match(wideList(openedPanel), /^\s{5}● write/m);
	assert.match(wideList(openedPanel), new RegExp(`^\\s{5}○ ${mcpName}`, "m"));

	context.sessionManager.getBranch = () => [customEntry({ version: 1, inactiveToolNames: ["read"] })];
	await handlers.get("session_tree")[0]({ type: "session_tree" }, context);
	assert.deepEqual(active, ["write", mcpName]);
	assert.deepEqual(entries, []);
});
