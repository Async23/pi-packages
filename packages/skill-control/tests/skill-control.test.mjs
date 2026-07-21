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
	classifySkillSource,
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

test("skillVisibility distinguishes model, manual, and excluded", () => {
	const item = { path: "/tmp/a", disableModelInvocation: false };
	assert.equal(skillVisibility(item, new Set()), "model");
	assert.equal(skillVisibility({ ...item, disableModelInvocation: true }, new Set()), "manual");
	assert.equal(skillVisibility(item, new Set(["/tmp/a"])), "excluded");
	assert.equal(visibilityLabel("manual"), "Manual /skill:name only");
});
