import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const peerRoot = "/opt/homebrew/lib/node_modules";
const codingAgentUrl = pathToFileURL(
	join(peerRoot, "@earendil-works/pi-coding-agent/dist/index.js"),
).href;

const { formatSkillsForPrompt } = await import(codingAgentUrl);
const extension = await import("../extensions/index.ts");
const {
	SkillControlPanel,
	accessForState,
	accessStateLabel,
	applySkillAccessToPrompt,
	canonicalPath,
	classifySkillSource,
	defaultSkillAccess,
	parseSkillCommand,
	readPolicyConfig,
	replaceSkillsSection,
	resolveSkillAccess,
	skillAccessState,
} = extension;
const { writePolicyConfig } = await import("../extensions/policy.ts");

const skillRoot = mkdtempSync(join(tmpdir(), "pi-skill-control-"));
after(() => rmSync(skillRoot, { recursive: true, force: true }));

function makeSkill(name, options = {}) {
	const dir = options.dir ?? join(skillRoot, name);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "SKILL.md");
	writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: ${options.description ?? `${name} skill`}\n---\n\n# ${name}\n`,
		"utf8",
	);
	return {
		name,
		description: options.description ?? `${name} skill`,
		filePath,
		baseDir: dir,
		sourceInfo: {
			path: filePath,
			source: options.source ?? "auto",
			scope: options.scope ?? "user",
			origin: options.origin ?? "top-level",
			baseDir: dir,
		},
		disableModelInvocation: options.disableModelInvocation === true,
	};
}

test("replaceSkillsSection swaps or inserts available_skills", () => {
	const original = formatSkillsForPrompt([makeSkill("alpha"), makeSkill("beta")]);
	const effective = formatSkillsForPrompt([makeSkill("alpha")]);
	assert.equal(replaceSkillsSection(`prefix${original}suffix`, original, effective), `prefix${effective}suffix`);

	const inserted = replaceSkillsSection("prefix\nCurrent working directory: /tmp", "", effective);
	assert.equal(inserted, `prefix${effective}\nCurrent working directory: /tmp`);
	assert.equal(replaceSkillsSection("no marker", "", effective), `no marker${effective}`);
});

test("model policy can hide normal skills and expose user-only Skill defaults", () => {
	const alpha = makeSkill("alpha");
	const userOnly = makeSkill("user-only", { disableModelInvocation: true });
	const skills = [alpha, userOnly];
	const prompt = `prefix${formatSkillsForPrompt(skills)}\nCurrent working directory: /tmp`;
	const overrides = new Map([
		[canonicalPath(alpha.filePath), accessForState("user")],
		[canonicalPath(userOnly.filePath), accessForState("both")],
	]);

	const effective = applySkillAccessToPrompt(prompt, skills, overrides);
	assert.doesNotMatch(effective, /<name>alpha<\/name>/);
	assert.match(effective, /<name>user-only<\/name>/);
});

test("user-only policy changes leave the model prompt untouched", () => {
	const skill = makeSkill("model-only");
	const prompt = `prefix${formatSkillsForPrompt([skill])}suffix`;
	const overrides = new Map([[canonicalPath(skill.filePath), accessForState("model")]]);
	assert.equal(applySkillAccessToPrompt(prompt, [skill], overrides), prompt);
});

test("a saved setting overrides the Skill default", () => {
	const skill = makeSkill("precedence", { disableModelInvocation: true });
	const path = canonicalPath(skill.filePath);
	const fromDefault = resolveSkillAccess(path, defaultSkillAccess(skill), new Map());
	assert.deepEqual(fromDefault, { access: { model: false, user: true }, source: "default" });

	const overrides = new Map([[path, accessForState("model")]]);
	assert.deepEqual(resolveSkillAccess(path, defaultSkillAccess(skill), overrides), {
		access: { model: true, user: false },
		source: "override",
	});
});

test("all four access states map to independent model and user permissions", () => {
	assert.deepEqual(accessForState("both"), { model: true, user: true });
	assert.deepEqual(accessForState("model"), { model: true, user: false });
	assert.deepEqual(accessForState("user"), { model: false, user: true });
	assert.deepEqual(accessForState("neither"), { model: false, user: false });
	for (const state of ["both", "model", "user", "neither"]) {
		assert.equal(skillAccessState(accessForState(state)), state);
	}
	assert.equal(accessStateLabel("both"), "Model + User");
	assert.equal(accessStateLabel("user"), "User only");
});

test("legacy disabledPaths migrate to v3 neither overrides", () => {
	const configPath = join(skillRoot, "legacy", "skill-control.json");
	mkdirSync(join(skillRoot, "legacy"), { recursive: true });
	const skill = makeSkill("legacy-disabled");
	writeFileSync(configPath, `${JSON.stringify({ version: 1, disabledPaths: [skill.filePath] })}\n`, "utf8");

	const loaded = readPolicyConfig(configPath);
	assert.equal(loaded.migrated, true);
	assert.deepEqual(loaded.overrides.get(realpathSync.native(skill.filePath)), { model: false, user: false });

	writePolicyConfig(configPath, loaded.overrides);
	const persisted = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal(persisted.version, 3);
	assert.deepEqual(persisted.overrides[realpathSync.native(skill.filePath)], { model: false, user: false });
});

test("classifySkillSource labels discovered origins without Extra scan config", () => {
	const home = skillRoot;
	const agents = makeSkill("from-agents", { dir: join(home, ".agents", "skills", "from-agents") });
	const packaged = makeSkill("from-package", {
		dir: join(home, "npm", "pkg", "skills", "from-package"),
		source: "npm:example-pkg",
		origin: "package",
	});
	const cli = makeSkill("from-cli", { source: "cli", scope: "temporary" });
	const injected = makeSkill("from-extension", { source: "extension:/tmp/review.ts", scope: "temporary" });
	const explicitPath = makeSkill("from-explicit-path", { source: "local", scope: "temporary" });

	assert.deepEqual(classifySkillSource(agents, home, join(home, ".pi", "agent"), home), {
		kind: "agents",
		label: "Agents (user)",
	});
	assert.deepEqual(classifySkillSource(packaged, home, join(home, ".pi", "agent"), home), {
		kind: "package",
		label: "Package (example-pkg)",
	});
	assert.deepEqual(classifySkillSource(cli, home, join(home, ".pi", "agent"), home), {
		kind: "cli",
		label: "CLI (--skill)",
	});
	assert.deepEqual(classifySkillSource(injected, home, join(home, ".pi", "agent"), home), {
		kind: "extension",
		label: "Extension (review)",
	});
	assert.deepEqual(classifySkillSource(explicitPath, home, join(home, ".pi", "agent"), home), {
		kind: "path",
		label: "Explicit path (temporary)",
	});
});

test("parseSkillCommand only recognizes direct /skill invocations", () => {
	assert.equal(parseSkillCommand("/skill:review"), "review");
	assert.equal(parseSkillCommand("/skill:review focus tests"), "review");
	assert.equal(parseSkillCommand("please use /skill:review"), undefined);
	assert.equal(parseSkillCommand("/skills"), undefined);
});

const plainTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function makePanelItem(name, sourceKind, sourceLabel, options = {}) {
	return {
		path: `/skills/${name}/SKILL.md`,
		name,
		label: `/skills/${name}/SKILL.md`,
		description: options.description ?? `${name} description`,
		sourceKind,
		sourceLabel,
		content: options.content ?? `# ${name}\n`,
		defaultAccess: options.defaultAccess ?? { model: true, user: true },
	};
}

function makePanel(onDone = () => undefined, options = {}) {
	const items = options.items ?? [
		makePanelItem("agents-both", "agents", "Agents (user)"),
		makePanelItem("agents-user", "agents", "Agents (user)", {
			defaultAccess: { model: false, user: true },
		}),
		makePanelItem("agents-project", "agents", "Agents (project)"),
		makePanelItem("package-skill", "package", "Package (example-pkg)"),
		makePanelItem("settings-model", "settings", "Settings (user)"),
		makePanelItem("cli-skill", "cli", "CLI (--skill)"),
	];
	return new SkillControlPanel({
		tui: { terminal: { rows: 80 }, requestRender() {} },
		theme: options.theme ?? plainTheme,
		keybindings: {
			matches: (data, action) =>
				(action === "tui.select.up" && data === "UP") ||
				(action === "tui.select.down" && data === "DOWN") ||
				(action === "tui.select.confirm" && data === "ENTER") ||
				(action === "tui.select.cancel" && data === "ESC"),
		},
		items,
		overrides: new Map([
			["/skills/settings-model/SKILL.md", accessForState("model")],
			["/skills/agents-project/SKILL.md", accessForState("neither")],
		]),
		onDone,
	});
}

function widePane(panel, column) {
	return panel
		.render(120)
		.flatMap((line) => {
			const columns = line.split("│");
			return columns.length >= 4 ? [columns[column]] : [];
		})
		.join("\n");
}

function wideList(panel) {
	return widePane(panel, 1);
}

function widePreview(panel) {
	return widePane(panel, 2);
}

function listLine(panel, skillName) {
	return wideList(panel)
		.split("\n")
		.find((line) => line.includes(skillName));
}

test("panel presents actual discovered sources and all four states without Extra scan", () => {
	const panel = makePanel();
	const output = panel.render(120).join("\n");

	assert.match(output, /Access\s+● 3 Model \+ User\s+◐ 1 Model only\s+◑ 1 User only\s+○ 1 Neither/);
	assert.doesNotMatch(output, /◆|Enabled|Manual only|Disabled/);
	assert.match(output, /Sources\s+\[ALL 6\]\s+Agents 3\s+Package 1\s+Settings 1\s+CLI 1/);
	assert.doesNotMatch(output, /Extra scan|Claude off|Codex off/);
});

test("wide preview shows the selected path before the Skill body without redundant metadata", () => {
	const panel = makePanel();
	const preview = widePreview(panel);

	assert.match(preview, /\/skills\/agents-both\/SKILL\.md/);
	assert.match(preview, /# agents-both/);
	assert.ok(preview.indexOf("/skills/agents-both/SKILL.md") < preview.indexOf("# agents-both"));
	assert.doesNotMatch(
		preview,
		/agents-both description|Access from|Agents \(user\)|Model \+ User|\d+ lines|\d+ (?:B|KB|MB)|tokens|View|wrapped rows/,
	);
});

test("preview highlights YAML frontmatter with Pi syntax theme roles", () => {
	const styled = [];
	const theme = {
		...plainTheme,
		fg(color, text) {
			styled.push({ color, text });
			return text;
		},
	};
	const item = makePanelItem("highlighted", "agents", "Agents (user)", {
		content: `---
name: highlighted
description: >
  Multi-line description.
enabled: true
priority: 2
tags:
  - docs
# note
---
# highlighted
`,
	});
	const panel = makePanel(() => undefined, { items: [item], theme });
	panel.render(120);

	const hasStyle = (color, text) => styled.some((entry) => entry.color === color && entry.text === text);
	assert.equal(styled.filter((entry) => entry.color === "syntaxPunctuation" && entry.text === "---").length, 2);
	assert.ok(hasStyle("syntaxVariable", "name"));
	assert.ok(hasStyle("syntaxString", "highlighted"));
	assert.ok(hasStyle("syntaxVariable", "description"));
	assert.ok(hasStyle("syntaxOperator", ">"));
	assert.ok(hasStyle("syntaxString", "Multi-line description."));
	assert.ok(hasStyle("syntaxKeyword", "true"));
	assert.ok(hasStyle("syntaxNumber", "2"));
	assert.ok(hasStyle("syntaxPunctuation", "- "));
	assert.ok(hasStyle("syntaxComment", "# note"));
	assert.ok(hasStyle("mdHeading", "# highlighted"));
});

test("Skill rows mark only access that differs from the Skill default", () => {
	const panel = makePanel();
	const list = wideList(panel);

	assert.doesNotMatch(listLine(panel, "agents-both"), /Non-default/);
	assert.doesNotMatch(listLine(panel, "agents-user"), /Non-default/);
	assert.match(listLine(panel, "agents-project"), /Non-default/);
	assert.match(listLine(panel, "settings-model"), /Non-default/);
	assert.doesNotMatch(list, /Model \+ User|Model only|User only|Neither/);
});

test("wide footer follows the focused pane", () => {
	const panel = makePanel();
	let output = panel.render(120).join("\n");

	assert.match(output, /j\/k select\s+\/ filter\s+Space cycle\s+\? guide\s+Tab Preview\s+h\/l source/);
	assert.doesNotMatch(output, /Enter Preview/);
	assert.doesNotMatch(output, /PgUp\/PgDn scroll|Tab Skills/);

	panel.handleInput("ENTER");
	output = panel.render(120).join("\n");
	assert.match(output, /Tab Preview/);
	assert.doesNotMatch(output, /Tab Skills/);

	panel.handleInput("\t");
	output = panel.render(120).join("\n");

	assert.match(output, /j\/k\/PgUp\/PgDn scroll\s+\/ filter\s+\? guide\s+Tab Skills\s+h\/l source/);
	assert.doesNotMatch(output, /Type filter|Enter Preview|Tab Preview|Space cycle/);
});

test("narrow layouts keep the selected path without repeating access metadata", () => {
	const panel = makePanel();
	let output = panel.render(48).join("\n");
	assert.match(output, /\/skills\/agents-both\/SKILL\.md/);
	assert.doesNotMatch(output, /Skill default|Saved setting/);

	panel.handleInput("ENTER");
	output = panel.render(48).join("\n");

	assert.match(output, /Skill preview/);
	assert.match(output, /\/skills\/agents-both\/SKILL\.md/);
	assert.match(output, /# agents-both/);
	assert.doesNotMatch(output, /agents-both description|Access from|Agents \(user\)|\d+ lines|\d+ (?:B|KB|MB)|tokens|View|wrapped rows/);
});

test("filter input requires slash and treats hjkl as query text", () => {
	const panel = makePanel();
	panel.render(120);
	for (const character of "abc") panel.handleInput(character);
	let output = panel.render(120).join("\n");

	assert.match(output, /Filter\s+\/ to filter skills/);
	assert.match(output, /agents-both/);

	panel.handleInput("/");
	for (const character of "skill") panel.handleInput(character);
	output = panel.render(120).join("\n");

	assert.match(output, /Filter\s+\/skill_/);
	assert.match(output, /cli-skill/);
	assert.match(output, /Type filter\s+↑↓ select\s+Enter keep\s+Esc cancel/);
});

test("vim-style hjkl navigate outside filter input", () => {
	const panel = makePanel();
	panel.render(120);

	panel.handleInput("j");
	assert.match(widePreview(panel), /\/skills\/agents-user\/SKILL\.md/);
	panel.handleInput("k");
	assert.match(widePreview(panel), /\/skills\/agents-both\/SKILL\.md/);

	panel.handleInput("l");
	assert.match(panel.render(120).join("\n"), /Sources\s+ALL 6\s+\[Agents 3\]/);
	panel.handleInput("h");
	assert.match(panel.render(120).join("\n"), /Sources\s+\[ALL 6\]\s+Agents 3/);
});

test("Enter keeps a filter while Esc cancels editing, clears the filter, then closes", () => {
	let result;
	const panel = makePanel((value) => {
		result = value;
	});
	panel.render(120);
	panel.handleInput("/");
	for (const character of "skill") panel.handleInput(character);
	panel.handleInput("ENTER");
	let output = panel.render(120).join("\n");

	assert.match(output, /Filter\s+\/skill/);
	assert.doesNotMatch(output, /\/skill_/);
	assert.match(output, /j\/k select\s+\/ filter/);

	panel.handleInput("/");
	panel.handleInput("x");
	assert.match(panel.render(120).join("\n"), /Filter\s+\/skillx_/);
	panel.handleInput("ESC");
	output = panel.render(120).join("\n");
	assert.match(output, /Filter\s+\/skill/);
	assert.doesNotMatch(output, /skillx|\/skill_/);

	panel.handleInput("ESC");
	output = panel.render(120).join("\n");
	assert.match(output, /Filter\s+\/ to filter skills/);
	assert.equal(result, undefined);

	panel.handleInput("ESC");
	assert.deepEqual(result, { action: "close" });
});

test("filter input takes precedence over shortcuts and can start from Preview", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("\t");
	panel.handleInput("/");
	panel.handleInput(" ");
	panel.handleInput("?");
	const output = panel.render(120).join("\n");

	assert.match(output, /Filter\s+\/ \?_/);
	assert.match(output, /Type filter\s+↑↓ select\s+Enter keep\s+Esc cancel/);
	assert.doesNotMatch(output, /Skill access guide|Pending 1/);
});

test("Space cycles all four access states directly in the list", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput(" ");
	let output = panel.render(120).join("\n");
	assert.match(listLine(panel, "agents-both"), /Non-default/);
	assert.match(output, /Model \+ User → Model only · Pending 1/);

	panel.handleInput(" ");
	output = panel.render(120).join("\n");
	assert.match(output, /Model only → User only · Pending 1/);

	panel.handleInput(" ");
	output = panel.render(120).join("\n");
	assert.match(output, /User only → Neither · Pending 1/);

	panel.handleInput(" ");
	output = panel.render(120).join("\n");
	assert.doesNotMatch(listLine(panel, "agents-both"), /Non-default/);
	assert.match(output, /Neither → Model \+ User \(default\) · No pending changes/);
});

test("cycling to the Skill default removes the saved override", () => {
	let result;
	const panel = makePanel((value) => {
		result = value;
	});
	panel.render(120);
	for (let index = 0; index < 4; index++) panel.handleInput("DOWN");
	panel.handleInput(" ");
	panel.handleInput(" ");
	panel.handleInput(" ");

	const output = panel.render(120).join("\n");
	assert.doesNotMatch(listLine(panel, "settings-model"), /Non-default/);
	assert.match(output, /Neither → Model \+ User \(default\) · Pending 1/);

	panel.handleInput("\x13");
	assert.equal(result.action, "apply");
	assert.equal(result.overrides.has("/skills/settings-model/SKILL.md"), false);
});

test("cycled states stay draft-only until Ctrl+S applies them", () => {
	let result;
	const panel = makePanel((value) => {
		result = value;
	});
	panel.render(120);
	panel.handleInput(" ");

	assert.equal(result, undefined);
	assert.match(panel.render(120).join("\n"), /Pending 1/);
	panel.handleInput("\x13");
	assert.equal(result.action, "apply");
	assert.deepEqual(result.overrides.get("/skills/agents-both/SKILL.md"), {
		model: true,
		user: false,
	});
});

test("Esc protects pending changes from accidental loss", () => {
	let result;
	const panel = makePanel((value) => {
		result = value;
	});
	panel.render(120);
	panel.handleInput(" ");
	panel.handleInput("ESC");
	assert.match(panel.render(120).join("\n"), /Discard 1 pending change/);
	panel.handleInput("n");
	assert.equal(result, undefined);
	assert.match(panel.render(120).join("\n"), /Pending 1/);
});

test("the access guide explains the matrix without editing controls", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("?");
	let output = panel.render(120).join("\n");

	assert.match(output, /Skill access guide/);
	assert.match(output, /Model visibility and direct \/skill access are controlled independently/);
	assert.match(output, /Model\s+You \(\/skill\)/);
	assert.match(output, /●\s+Model \+ User\s+✓\s+✓/);
	assert.match(output, /◐\s+Model only\s+✓\s+—/);
	assert.match(output, /◑\s+User only\s+—\s+✓/);
	assert.match(output, /○\s+Neither\s+—\s+—/);
	assert.doesNotMatch(output, /Current|Use Skill default|Enter choose|Save for/);

	panel.handleInput(" ");
	output = panel.render(120).join("\n");
	assert.match(output, /Skill access guide/);

	panel.handleInput("ESC");
	output = panel.render(120).join("\n");
	assert.match(listLine(panel, "agents-both"), /agents-both/);
	assert.doesNotMatch(listLine(panel, "agents-both"), /Non-default/);
});

test("Space does not change access while Preview is focused", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("\t");
	panel.handleInput(" ");
	panel.handleInput("\t");
	const output = panel.render(120).join("\n");

	assert.match(listLine(panel, "agents-both"), /agents-both/);
	assert.doesNotMatch(listLine(panel, "agents-both"), /Non-default/);
	assert.doesNotMatch(output, /Pending 1/);
});

test("panel wraps the compact header and guide within narrow terminals", () => {
	const width = 48;
	const panel = makePanel();
	let lines = panel.render(width);
	let output = lines.join("\n");
	assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length === width));
	for (const expected of ["Access", "Sources", "Agents 3", "Package 1", "Filter", "/ to filter skills"]) {
		assert.ok(output.includes(expected), `missing narrow header content: ${expected}`);
	}

	panel.handleInput("/");
	lines = panel.render(width);
	output = lines.join("\n");
	assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length === width));
	assert.match(output, /Filter\s+\/_/);
	assert.match(output, /Type filter\s+Enter keep\s+Esc cancel/);

	panel.handleInput("ESC");
	panel.handleInput("?");
	lines = panel.render(width);
	output = lines.join("\n");
	assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length === width));
	assert.match(output, /Skill access guide/);
});

test("search fuzzy-matches non-contiguous name segments", () => {
	const panel = new SkillControlPanel({
		tui: { terminal: { rows: 80 }, requestRender() {} },
		theme: plainTheme,
		keybindings: { matches: () => false },
		items: [
			makePanelItem("my-pptx-html-local", "agents", "Agents (user)"),
			makePanelItem("my-pptx-local", "agents", "Agents (user)"),
		],
		globalOverrides: new Map(),
		projectOverrides: new Map(),
		overrides: new Map(),
		onDone: () => undefined,
	});
	panel.render(120);
	panel.handleInput("/");
	for (const character of "my-html") panel.handleInput(character);
	const output = panel.render(120).join("\n");

	assert.match(output, /Filter\s+\/my-html_/);
	assert.match(output, /my-pptx-html-local/);
	assert.doesNotMatch(output, /my-pptx-local/);
	assert.doesNotMatch(output, /No skills match/);
});

test("search ranks typo-close names without fuzzy-matching long descriptions", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("ask-better", "agents", "Agents (user)", {
				description: "More text, only then ask-better or do first.",
			}),
			makePanelItem("my-bruno-postman", "agents", "Agents (user)"),
			makePanelItem("my-boss-agent-cli", "agents", "Agents (user)"),
		],
	});
	panel.render(120);
	panel.handleInput("/");
	for (const character of "myboos") panel.handleInput(character);
	const list = wideList(panel);

	assert.doesNotMatch(list, /ask-better/);
	assert.match(list, /Agents \(user\) \(2\)/);
	assert.match(list, /my-boss-agent-cli/);
	assert.match(list, /my-bruno-postman/);
	assert.ok(list.indexOf("my-boss-agent-cli") < list.indexOf("my-bruno-postman"));
});
