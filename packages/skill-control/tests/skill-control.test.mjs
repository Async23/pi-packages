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

test("model policy can hide normal skills and expose manual-only skills", () => {
	const alpha = makeSkill("alpha");
	const manual = makeSkill("manual", { disableModelInvocation: true });
	const skills = [alpha, manual];
	const prompt = `prefix${formatSkillsForPrompt(skills)}\nCurrent working directory: /tmp`;
	const globalOverrides = new Map([
		[canonicalPath(alpha.filePath), accessForState("manual")],
		[canonicalPath(manual.filePath), accessForState("enabled")],
	]);

	const effective = applySkillAccessToPrompt(prompt, skills, globalOverrides, new Map());
	assert.doesNotMatch(effective, /<name>alpha<\/name>/);
	assert.match(effective, /<name>manual<\/name>/);
});

test("user-only policy changes leave the model prompt untouched", () => {
	const skill = makeSkill("model-only");
	const prompt = `prefix${formatSkillsForPrompt([skill])}suffix`;
	const globalOverrides = new Map([[canonicalPath(skill.filePath), accessForState("model")]]);
	assert.equal(applySkillAccessToPrompt(prompt, [skill], globalOverrides, new Map()), prompt);
});

test("project overrides global, which overrides the Skill default", () => {
	const skill = makeSkill("precedence", { disableModelInvocation: true });
	const path = canonicalPath(skill.filePath);
	const inherited = resolveSkillAccess(path, defaultSkillAccess(skill), new Map(), new Map());
	assert.deepEqual(inherited, { access: { model: false, user: true }, source: "default" });

	const global = new Map([[path, accessForState("model")]]);
	assert.deepEqual(resolveSkillAccess(path, defaultSkillAccess(skill), global, new Map()), {
		access: { model: true, user: false },
		source: "global",
	});

	const project = new Map([[path, accessForState("disabled")]]);
	assert.deepEqual(resolveSkillAccess(path, defaultSkillAccess(skill), global, project), {
		access: { model: false, user: false },
		source: "project",
	});
});

test("all four access states map to independent model and user permissions", () => {
	assert.deepEqual(accessForState("enabled"), { model: true, user: true });
	assert.deepEqual(accessForState("model"), { model: true, user: false });
	assert.deepEqual(accessForState("manual"), { model: false, user: true });
	assert.deepEqual(accessForState("disabled"), { model: false, user: false });
	for (const state of ["enabled", "model", "manual", "disabled"]) {
		assert.equal(skillAccessState(accessForState(state)), state);
	}
	assert.equal(accessStateLabel("manual"), "Manual only");
});

test("legacy disabledPaths migrate to v3 disabled overrides", () => {
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
		description: `${name} description`,
		sourceKind,
		sourceLabel,
		content: `# ${name}\n`,
		defaultAccess: options.defaultAccess ?? { model: true, user: true },
		sourceScope: options.sourceScope ?? "user",
	};
}

function makePanel(onDone = () => undefined) {
	const items = [
		makePanelItem("agents-enabled", "agents", "Agents (user)"),
		makePanelItem("agents-manual", "agents", "Agents (user)", {
			defaultAccess: { model: false, user: true },
		}),
		makePanelItem("agents-project", "agents", "Agents (project)", { sourceScope: "project" }),
		makePanelItem("package-skill", "package", "Package (example-pkg)"),
		makePanelItem("settings-model", "settings", "Settings (user)"),
		makePanelItem("cli-skill", "cli", "CLI (--skill)", { sourceScope: "temporary" }),
	];
	return new SkillControlPanel({
		tui: { terminal: { rows: 80 }, requestRender() {} },
		theme: plainTheme,
		keybindings: {
			matches: (data, action) =>
				(action === "tui.select.up" && data === "UP") ||
				(action === "tui.select.down" && data === "DOWN") ||
				(action === "tui.select.confirm" && data === "ENTER") ||
				(action === "tui.select.cancel" && data === "ESC"),
		},
		items,
		globalOverrides: new Map([["/skills/settings-model/SKILL.md", accessForState("model")]]),
		projectOverrides: new Map([["/skills/agents-project/SKILL.md", accessForState("disabled")]]),
		projectTrusted: true,
		onDone,
	});
}

test("panel presents actual discovered sources and all four states without Extra scan", () => {
	const panel = makePanel();
	const output = panel.render(120).join("\n");

	assert.match(output, /Visibility\s+● 3 enabled\s+◆ 1 model only\s+◐ 1 manual only\s+○ 1 disabled/);
	assert.match(output, /Sources\s+\[ALL 6\]\s+Agents 3\s+Package 1\s+Settings 1\s+CLI 1/);
	assert.doesNotMatch(output, /Extra scan|Claude off|Codex off/);
	assert.match(output, /Space access\s+Ctrl\+S apply/);
});

test("search accepts h and l instead of treating them as hidden navigation keys", () => {
	const panel = makePanel();
	panel.render(120);
	for (const character of "skill") panel.handleInput(character);
	const output = panel.render(120).join("\n");

	assert.match(output, /Search\s+skill_/);
	assert.match(output, /cli-skill/);
});

test("Space opens a direct four-state selector with Global and Project scopes", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput(" ");
	let output = panel.render(120).join("\n");

	assert.match(output, /Set Skill access/);
	assert.match(output, /\[Global\]\s+Project/);
	assert.match(output, /Enabled\s+Model on · \/skill on/);
	assert.match(output, /Model only\s+Model on · \/skill off/);
	assert.match(output, /Manual only\s+Model off · \/skill on/);
	assert.match(output, /Disabled\s+Model off · \/skill off/);
	assert.match(output, /Reset to inherited/);

	panel.handleInput("\t");
	output = panel.render(120).join("\n");
	assert.match(output, /Global\s+\[Project\]/);
});

test("scope selector shows inheritance for the scope being edited", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("DOWN");
	panel.handleInput("DOWN");
	panel.handleInput(" ");

	let output = panel.render(120).join("\n");
	assert.match(output, /\[Project\]/);
	assert.match(output, /project override exists/);

	panel.handleInput("\t");
	output = panel.render(120).join("\n");
	assert.match(output, /\[Global\]/);
	assert.match(output, /Currently inherited · Enabled/);
});

test("state choices stay draft-only until Ctrl+S applies them", () => {
	let result;
	const panel = makePanel((value) => {
		result = value;
	});
	panel.render(120);
	panel.handleInput(" ");
	panel.handleInput("DOWN");
	panel.handleInput("ENTER");

	assert.equal(result, undefined);
	assert.match(panel.render(120).join("\n"), /Pending 1/);
	panel.handleInput("\x13");
	assert.equal(result.action, "apply");
	assert.deepEqual(result.globalOverrides.get("/skills/agents-enabled/SKILL.md"), {
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
	panel.handleInput("DOWN");
	panel.handleInput("ENTER");
	panel.handleInput("ESC");
	assert.match(panel.render(120).join("\n"), /Discard 1 pending change/);
	panel.handleInput("n");
	assert.equal(result, undefined);
	assert.match(panel.render(120).join("\n"), /Pending 1/);
});

test("panel wraps the compact header and dialogs within narrow terminals", () => {
	const width = 48;
	const panel = makePanel();
	let lines = panel.render(width);
	let output = lines.join("\n");
	assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length === width));
	for (const expected of ["Visibility", "Sources", "Agents 3", "Package 1", "Search", "filter skills_"]) {
		assert.ok(output.includes(expected), `missing narrow header content: ${expected}`);
	}

	panel.handleInput(" ");
	lines = panel.render(width);
	output = lines.join("\n");
	assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length === width));
	assert.match(output, /Set Skill access/);
});
