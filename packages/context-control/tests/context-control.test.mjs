import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const peerRoot = "/opt/homebrew/lib/node_modules";
const codingAgentUrl = pathToFileURL(
	join(peerRoot, "@earendil-works/pi-coding-agent/dist/index.js"),
).href;
const peerRequire = createRequire(codingAgentUrl);
const tuiUrl = pathToFileURL(peerRequire.resolve("@earendil-works/pi-tui")).href;

const { CURSOR_MARKER, visibleWidth } = await import(tuiUrl);
const {
	ContextControlPanel,
	canonicalPath,
	changedPathCount,
	filterProjectContext,
	pathsEqual,
	readConfig,
	renderProjectContext,
	replacePaths,
	writeConfig,
} = await import("../extensions/index.ts");

const contextRoot = mkdtempSync(join(tmpdir(), "pi-context-control-"));
after(() => rmSync(contextRoot, { recursive: true, force: true }));

test("filterProjectContext removes only disabled instruction files", () => {
	const rootPath = join(contextRoot, "root", "AGENTS.md");
	const projectPath = join(contextRoot, "project", "AGENTS.md");
	mkdirSync(join(contextRoot, "root"), { recursive: true });
	mkdirSync(join(contextRoot, "project"), { recursive: true });
	writeFileSync(rootPath, "root instructions", "utf8");
	writeFileSync(projectPath, "project instructions", "utf8");
	const files = [
		{ path: rootPath, content: "root instructions" },
		{ path: projectPath, content: "project instructions" },
	];
	const prompt = `prefix${renderProjectContext(files)}suffix`;
	const filtered = filterProjectContext(prompt, files, new Set([canonicalPath(rootPath)]));

	assert.doesNotMatch(filtered, /root instructions/);
	assert.match(filtered, /project instructions/);
	assert.match(filtered, /^prefix/);
	assert.match(filtered, /suffix$/);
});

test("configuration and set helpers preserve canonical disabled paths", () => {
	const first = join(contextRoot, "config", "first", "AGENTS.md");
	const second = join(contextRoot, "config", "second", "AGENTS.md");
	for (const path of [first, second]) {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, path, "utf8");
	}
	const configPath = join(contextRoot, "config", "context-control.json");
	writeConfig(configPath, new Set([second, first]));

	const loaded = readConfig(configPath);
	assert.equal(loaded.error, undefined);
	assert.deepEqual([...loaded.disabledPaths].sort(), [canonicalPath(first), canonicalPath(second)].sort());
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		version: 1,
		disabledPaths: [first, second].sort(),
	});
	assert.equal(pathsEqual(loaded.disabledPaths, new Set([canonicalPath(first), canonicalPath(second)])), true);
	assert.equal(changedPathCount(loaded.disabledPaths, new Set([canonicalPath(first)])), 1);

	const target = new Set(["stale"]);
	replacePaths(target, loaded.disabledPaths);
	assert.equal(pathsEqual(target, loaded.disabledPaths), true);
});

const plainTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function terminalText(text) {
	return text.replaceAll(CURSOR_MARKER, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function makeItems() {
	return [
		{
			path: "/contexts/user/AGENTS.md",
			label: "~/.pi/agent/AGENTS.md",
			scope: "User",
			content: Array.from({ length: 40 }, (_, index) => `user-line-${String(index + 1).padStart(2, "0")}`).join("\n"),
		},
		{
			path: "/contexts/inherited/AGENTS.md",
			label: "/workspace/AGENTS.md",
			scope: "Inherited",
			content: "# Inherited\n",
		},
		{
			path: "/contexts/project/AGENTS.md",
			label: "/workspace/project/AGENTS.md",
			scope: "Current project",
			content: "# Project\n",
		},
	];
}

function makePanel(onDone = () => undefined, options = {}) {
	return new ContextControlPanel({
		tui: { terminal: { rows: options.rows ?? 80 }, requestRender() {} },
		theme: options.theme ?? plainTheme,
		keybindings: {
			matches: (data, action) =>
				(action === "tui.select.up" && data === "UP") ||
				(action === "tui.select.down" && data === "DOWN") ||
				(action === "tui.select.pageUp" && data === "PAGE_UP") ||
				(action === "tui.select.pageDown" && data === "PAGE_DOWN") ||
				(action === "tui.select.confirm" && data === "ENTER") ||
				(action === "tui.select.cancel" && data === "ESC"),
		},
		items: options.items ?? makeItems(),
		disabledPaths: options.disabledPaths ?? new Set(["/contexts/project/AGENTS.md"]),
		onApply: options.onApply ?? (() => undefined),
		onDone,
	});
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

function widePreview(panel) {
	return widePane(panel, 2);
}

function listLine(panel, pathFragment) {
	return wideList(panel)
		.split("\n")
		.find((line) => line.includes(pathFragment));
}

test("panel presents grouped Context files with default, override, and summary states", () => {
	const panel = makePanel();
	const output = terminalText(panel.render(120).join("\n"));

	assert.match(output, /State\s+● 2 Included\s+·\s+○ 1 Excluded/);
	assert.match(output, /▾ User \(1\)/);
	assert.match(output, /▾ Inherited \(1\)/);
	assert.match(output, /▾ Current project \(1\)/);
	assert.match(listLine(panel, "~/.pi/agent/AGENTS.md"), /Included/);
	assert.match(listLine(panel, "/workspace/project"), /Excluded/);
	assert.match(output, /Current Included · Default Included · Using default/);
});

test("group headings are selectable and fold with the same keys as Skills", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("k");
	panel.handleInput(" ");
	let output = terminalText(panel.render(120).join("\n"));

	assert.match(output, /▸ User \(1\)/);
	assert.doesNotMatch(wideList(panel), /~\/\.pi\/agent\/AGENTS\.md/);
	assert.match(output, /Group\s+User/);
	assert.match(output, /State\s+Collapsed/);

	panel.handleInput("l");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /▾ User \(1\)/);
	assert.match(wideList(panel), /~\/\.pi\/agent\/AGENTS\.md/);
});

test("filter input requires slash and uses Pi's native editor", () => {
	const panel = makePanel();
	panel.focused = true;
	panel.render(120);
	for (const character of "abc") panel.handleInput(character);
	let output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /Filter\s+\/ to filter paths/);
	assert.match(output, /~\/\.pi\/agent\/AGENTS\.md/);

	panel.handleInput("/");
	for (const character of "project") panel.handleInput(character);
	const rendered = panel.render(120).join("\n");
	output = terminalText(rendered);
	assert.ok(rendered.includes(CURSOR_MARKER));
	assert.match(output, /Filter\s+project/);
	assert.doesNotMatch(output, /Filter\s+\/project/);
	assert.match(output, /\/workspace\/project\/AGENTS\.md/);
	assert.doesNotMatch(wideList(panel), /~\/\.pi\/agent\/AGENTS\.md/);
	assert.match(output, /Type filter\s+←\/→ cursor\s+↑\/↓ select\s+Ctrl\+U clear\s+Ctrl\+W word/);
});

test("Enter keeps a filter while Esc cancels editing, clears the filter, then closes", () => {
	let result;
	const panel = makePanel((value) => {
		result = value;
	});
	panel.render(120);
	panel.handleInput("/");
	for (const character of "project") panel.handleInput(character);
	panel.handleInput("ENTER");
	assert.match(terminalText(panel.render(120).join("\n")), /Filter\s+project/);

	panel.handleInput("/");
	panel.handleInput("x");
	panel.handleInput("ESC");
	assert.match(terminalText(panel.render(120).join("\n")), /Filter\s+project/);
	panel.handleInput("ESC");
	assert.match(terminalText(panel.render(120).join("\n")), /Filter\s+\/ to filter paths/);
	assert.equal(result, undefined);
	panel.handleInput("ESC");
	assert.deepEqual(result, { action: "close" });
});

test("j/k navigate the active pane while h/l wrap focus", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("l");
	assert.match(terminalText(panel.render(120).join("\n")), /j\/k\/PgUp\/PgDn scroll\s+h\/l focus/);
	const beforeScroll = widePreview(panel);
	panel.handleInput("j");
	assert.notEqual(widePreview(panel), beforeScroll);

	panel.handleInput("l");
	assert.match(terminalText(panel.render(120).join("\n")), /j\/k select\s+h\/l focus/);
	panel.handleInput("h");
	assert.match(terminalText(panel.render(120).join("\n")), /j\/k\/PgUp\/PgDn scroll\s+h\/l focus/);
	panel.handleInput("h");
	assert.match(terminalText(panel.render(120).join("\n")), /j\/k select\s+h\/l focus/);
});

test("Space and Shift+Space stage changes while r resets and u undoes", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("\x1b[32;2u");
	let output = terminalText(panel.render(120).join("\n"));
	assert.match(listLine(panel, "~/.pi/agent/AGENTS.md"), /Pending/);
	assert.match(output, /Included → Excluded · Pending 1/);

	panel.handleInput("u");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /Excluded → Included \(default\) · No pending changes/);
	assert.match(listLine(panel, "~/.pi/agent/AGENTS.md"), /Included/);

	panel.handleInput(" ");
	panel.handleInput("r");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /Excluded → Included \(default\) · No pending changes/);
	assert.match(listLine(panel, "~/.pi/agent/AGENTS.md"), /Included/);
});

test("Ctrl+S applies without closing and establishes a new baseline", () => {
	let closeResult;
	const applied = [];
	const panel = makePanel(
		(value) => {
			closeResult = value;
		},
		{
			disabledPaths: new Set(),
			onApply(value) {
				applied.push(value);
			},
		},
	);
	panel.render(120);
	panel.handleInput("\x13");
	assert.equal(applied.length, 0);
	assert.equal(closeResult, undefined);

	panel.handleInput(" ");
	assert.equal(applied.length, 0);
	assert.match(terminalText(panel.render(120).join("\n")), /Pending 1/);
	panel.handleInput("\x13");
	assert.equal(applied.length, 1);
	assert.equal(applied[0].has("/contexts/user/AGENTS.md"), true);
	assert.equal(closeResult, undefined);
	assert.match(terminalText(panel.render(120).join("\n")), /Applied 1 Context change/);

	panel.handleInput(" ");
	assert.match(terminalText(panel.render(120).join("\n")), /Pending 1/);
	panel.handleInput("\x13");
	assert.equal(applied.length, 2);
	assert.equal(applied[1].has("/contexts/user/AGENTS.md"), false);
	panel.handleInput("ESC");
	assert.deepEqual(closeResult, { action: "close" });
});

test("failed Apply keeps changes pending and Esc protects them", () => {
	let result;
	let attempts = 0;
	const panel = makePanel(
		(value) => {
			result = value;
		},
		{
			disabledPaths: new Set(),
			onApply() {
				attempts += 1;
				throw new Error("Could not write Context control configuration");
			},
		},
	);
	panel.render(120);
	panel.handleInput(" ");
	panel.handleInput("\x13");
	let output = terminalText(panel.render(120).join("\n"));
	assert.equal(attempts, 1);
	assert.match(output, /Could not write Context control configuration/);
	assert.match(listLine(panel, "~/.pi/agent/AGENTS.md"), /Pending/);

	panel.handleInput("ESC");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /Discard 1 pending change/);
	panel.handleInput("n");
	assert.equal(result, undefined);
	assert.match(listLine(panel, "~/.pi/agent/AGENTS.md"), /Pending/);
});

test("Space does not edit Context state while Preview is focused", () => {
	const panel = makePanel(() => undefined, { disabledPaths: new Set() });
	panel.render(120);
	panel.handleInput("\t");
	panel.handleInput(" ");
	panel.handleInput("\t");
	const output = terminalText(panel.render(120).join("\n"));

	assert.match(listLine(panel, "~/.pi/agent/AGENTS.md"), /Included/);
	assert.doesNotMatch(output, /Pending 1/);
});

test("the state guide explains Context policy without editing it", () => {
	const panel = makePanel(() => undefined, { disabledPaths: new Set() });
	panel.render(120);
	panel.handleInput("?");
	let output = terminalText(panel.render(120).join("\n"));

	assert.match(output, /Context state guide/);
	assert.match(output, /●\s+Included\s+Added to the next agent prompt/);
	assert.match(output, /○\s+Excluded\s+Removed from prompts; file unchanged/);
	panel.handleInput(" ");
	assert.match(terminalText(panel.render(120).join("\n")), /Context state guide/);

	panel.handleInput("ESC");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(listLine(panel, "~/.pi/agent/AGENTS.md"), /Included/);
	assert.doesNotMatch(output, /Pending 1/);
});

test("narrow rendering and active filter remain within terminal width", () => {
	const width = 48;
	const panel = makePanel();
	let lines = panel.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) === width));
	assert.match(terminalText(lines.join("\n")), /Filter\s+\/ to filter paths/);

	panel.focused = true;
	panel.handleInput("/");
	for (const character of "project") panel.handleInput(character);
	lines = panel.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) === width));
	assert.match(terminalText(lines.join("\n")), /Type filter\s+Enter keep\s+Esc cancel/);
});
