import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
	classifySkillSource,
	discoverSummary,
	filterAvailableSkills,
	replaceSkillsSection,
	resolveDiscoverSkillPaths,
	skillVisibility,
	visibilityLabel,
} = extension;

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
			source: options.source ?? "local",
			scope: options.scope ?? "user",
			origin: options.origin ?? "top-level",
			baseDir: dir,
		},
		disableModelInvocation: options.disableModelInvocation === true,
	};
}

test("replaceSkillsSection swaps matching available_skills blocks", () => {
	const original = formatSkillsForPrompt([makeSkill("alpha"), makeSkill("beta")]);
	const enabled = formatSkillsForPrompt([makeSkill("alpha")]);
	const prompt = `prefix${original}suffix`;
	assert.equal(replaceSkillsSection(prompt, original, enabled), `prefix${enabled}suffix`);
	assert.equal(replaceSkillsSection(prompt, original, original), prompt);
	assert.equal(replaceSkillsSection("no skills here", original, enabled), "no skills here");
});

test("filterAvailableSkills removes disabled skill paths from the prompt", () => {
	const alpha = makeSkill("alpha");
	const beta = makeSkill("beta");
	const skills = [alpha, beta];
	const original = formatSkillsForPrompt(skills);
	const prompt = `You are pi.${original}\nCurrent working directory: /tmp`;

	const filtered = filterAvailableSkills(
		prompt,
		skills,
		new Set([realpathSync.native(beta.filePath)]),
	);
	assert.match(filtered, /<name>alpha<\/name>/);
	assert.doesNotMatch(filtered, /<name>beta<\/name>/);
	assert.equal(filterAvailableSkills(prompt, skills, new Set()), prompt);
});

test("filterAvailableSkills ignores skills already hidden from the model", () => {
	const manual = makeSkill("manual-only", { disableModelInvocation: true });
	const visible = makeSkill("visible");
	const skills = [manual, visible];
	const original = formatSkillsForPrompt(skills);
	const prompt = `prefix${original}suffix`;

	const filtered = filterAvailableSkills(
		prompt,
		skills,
		new Set([realpathSync.native(manual.filePath)]),
	);
	assert.equal(filtered, prompt);
});

test("classifySkillSource labels common skill roots", () => {
	const home = skillRoot;
	const agents = makeSkill("from-agents", {
		dir: join(home, ".agents", "skills", "from-agents"),
	});
	const claude = makeSkill("from-claude", {
		dir: join(home, ".claude", "skills", "from-claude"),
	});
	const packaged = makeSkill("from-package", {
		dir: join(home, "npm", "pkg", "skills", "from-package"),
		source: "npm:example-pkg",
		origin: "package",
	});

	assert.deepEqual(classifySkillSource(agents, home, join(home, ".pi", "agent"), home), {
		kind: "agents",
		label: "Agents (user)",
	});
	assert.deepEqual(classifySkillSource(claude, home, join(home, ".pi", "agent"), home), {
		kind: "claude",
		label: "Claude (user)",
	});
	assert.deepEqual(classifySkillSource(packaged, home, join(home, ".pi", "agent"), home), {
		kind: "package",
		label: "Package (example-pkg)",
	});
});

test("resolveDiscoverSkillPaths only returns enabled existing directories", () => {
	const home = join(skillRoot, "discover-home");
	const cwd = join(skillRoot, "discover-cwd");
	mkdirSync(join(home, ".claude", "skills"), { recursive: true });
	mkdirSync(join(cwd, ".codex", "skills"), { recursive: true });

	const paths = resolveDiscoverSkillPaths(
		{
			claudeUser: true,
			codexUser: false,
			opencodeUser: false,
			claudeProject: false,
			codexProject: true,
			customPaths: [],
		},
		cwd,
		home,
	);

	assert.deepEqual(paths, [
		join(home, ".claude", "skills"),
		join(cwd, ".codex", "skills"),
	]);
	assert.deepEqual(
		resolveDiscoverSkillPaths(
			{
				claudeUser: false,
				codexUser: false,
				opencodeUser: false,
				claudeProject: false,
				codexProject: false,
				customPaths: [],
			},
			cwd,
			home,
		),
		[],
	);
});

test("discoverSummary preserves enabled sources and the reload hint", () => {
	assert.equal(
		discoverSummary({
			claudeUser: true,
			codexUser: false,
			opencodeUser: true,
			claudeProject: false,
			codexProject: true,
			customPaths: ["/skills/one", "/skills/two"],
		}),
		"claude, opencode, codex-project, custom×2 · /reload after edits",
	);
});

test("skillVisibility distinguishes model, manual, and excluded", () => {
	const item = { path: "/tmp/a", disableModelInvocation: false };
	assert.equal(skillVisibility(item, new Set()), "model");
	assert.equal(skillVisibility({ ...item, disableModelInvocation: true }, new Set()), "manual");
	assert.equal(skillVisibility(item, new Set(["/tmp/a"])), "excluded");
	assert.equal(visibilityLabel("manual"), "Manual /skill:name only");
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
		disableModelInvocation: options.disableModelInvocation === true,
	};
}

function makePanel() {
	const items = [
		makePanelItem("agents-model", "agents", "Agents (user)"),
		makePanelItem("agents-manual", "agents", "Agents (user)", { disableModelInvocation: true }),
		makePanelItem("agents-project", "agents", "Agents (project)"),
		makePanelItem("package-skill", "package", "Package (example-pkg)"),
		makePanelItem("project-skill", "project", "Project"),
		makePanelItem("other-skill", "other", "Other"),
	];
	return new SkillControlPanel({
		tui: { terminal: { rows: 80 }, requestRender() {} },
		theme: plainTheme,
		keybindings: { matches: () => false },
		items,
		disabledPaths: new Set(["/skills/agents-project/SKILL.md"]),
		discoverSummary: discoverSummary({
			claudeUser: false,
			codexUser: false,
			opencodeUser: false,
			claudeProject: false,
			codexProject: false,
			customPaths: [],
		}),
		onToggle: () => undefined,
		onClose() {},
	});
}

test("skill panel groups complete header metadata into labeled rows", () => {
	const panel = makePanel();
	const lines = panel.render(120);
	const output = lines.join("\n");

	assert.match(output, /Visibility\s+● 4 model\s+◐ 1 manual\s+○ 1 excluded/);
	assert.match(output, /Scope\s+\[ALL 6\]/);
	assert.match(output, /User\s+Agents 2\s+Pi 0\s+Claude 0\s+Codex 0\s+OpenCode 0/);
	assert.match(output, /Project\s+Agents 1\s+Pi 0\s+Claude 0\s+Codex 0\s+OpenCode 0/);
	assert.match(output, /Other\s+Package 1\s+Project 1\s+Other 1/);
	assert.match(output, /Extra paths\s+Off · edit ~\/\.pi\/agent\/skill-control\.json/);
	assert.match(output, /Search\s+type to filter skills_/);

	panel.handleInput("\x1b[C");
	assert.match(panel.render(120).join("\n"), /User\s+\[Agents 2\]/);
	for (let index = 0; index < 5; index++) panel.handleInput("\x1b[C");
	assert.match(panel.render(120).join("\n"), /Project\s+\[Agents 1\]/);
});

test("skill panel wraps header metadata without exceeding a narrow terminal", () => {
	const width = 48;
	const lines = makePanel().render(width);
	const output = lines.join("\n");

	assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length === width));
	for (const expected of [
		"Visibility",
		"Scope",
		"User",
		"Project",
		"Other",
		"Agents 2",
		"OpenCode 0",
		"Package 1",
		"~/.pi/agent/skill-control.json",
		"filter skills_",
	]) {
		assert.ok(output.includes(expected), `missing narrow header content: ${expected}`);
	}
});
