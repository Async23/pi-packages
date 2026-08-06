import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const { formatSkillsForPrompt } = await import(codingAgentUrl);
const { CURSOR_MARKER, visibleWidth } = await import(tuiUrl);
const extension = await import("../extensions/index.ts");
const {
	SkillControlPanel,
	applyBlockedSkillsToPrompt,
	availabilityStateLabel,
	canonicalPath,
	classifySkillSource,
	effectiveSkillAvailability,
	nativeSkillAvailability,
	parseSkillCommand,
	readPolicyConfig,
	replaceSkillsSection,
	skillAvailabilityState,
} = extension;
const { writePolicyConfig } = await import("../extensions/policy.ts");
const {
	BLOCKED_ICON,
	detectNerdFontSupport,
	FALLBACK_USER_ICON,
	FONT_AWESOME_USER_ICON,
	userOnlyIconForSupport,
} = await import("../extensions/icons.ts");

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

test("policy can block a normal Skill without exposing a native command-only Skill", () => {
	const alpha = makeSkill("alpha");
	const commandOnly = makeSkill("command-only", { disableModelInvocation: true });
	const skills = [alpha, commandOnly];
	const prompt = `prefix${formatSkillsForPrompt(skills)}\nCurrent working directory: /tmp`;
	const blockedPaths = new Set([canonicalPath(alpha.filePath)]);

	const effective = applyBlockedSkillsToPrompt(prompt, skills, blockedPaths);
	assert.doesNotMatch(effective, /<name>alpha<\/name>/);
	assert.doesNotMatch(effective, /<name>command-only<\/name>/);
});

test("unblocked policy leaves Pi's native model visibility untouched", () => {
	const normal = makeSkill("normal");
	const commandOnly = makeSkill("command-only-unblocked", { disableModelInvocation: true });
	const skills = [normal, commandOnly];
	const prompt = `prefix${formatSkillsForPrompt(skills)}suffix`;
	assert.equal(applyBlockedSkillsToPrompt(prompt, skills, new Set()), prompt);
});

test("blocked policy only subtracts from native Skill availability", () => {
	const skill = makeSkill("native-command-only", { disableModelInvocation: true });
	const path = canonicalPath(skill.filePath);
	const native = nativeSkillAvailability(skill);
	assert.deepEqual(native, { modelVisible: false, commandAvailable: true });
	assert.deepEqual(effectiveSkillAvailability(path, native, new Set()), native);
	assert.deepEqual(effectiveSkillAvailability(path, native, new Set([path])), {
		modelVisible: false,
		commandAvailable: false,
	});
});

test("display states cover Pi native availability and blocked policy", () => {
	assert.equal(skillAvailabilityState({ modelVisible: true, commandAvailable: true }), "model-and-command");
	assert.equal(skillAvailabilityState({ modelVisible: false, commandAvailable: true }), "command-only");
	assert.equal(skillAvailabilityState({ modelVisible: false, commandAvailable: false }), "blocked");
	assert.equal(availabilityStateLabel("model-and-command"), "Model + /skill");
	assert.equal(availabilityStateLabel("command-only"), "/skill only");
	assert.equal(availabilityStateLabel("blocked"), "Blocked");
});

test("user icon detection prefers Nerd Font and has an explicit fallback", () => {
	assert.equal(userOnlyIconForSupport(true), FONT_AWESOME_USER_ICON);
	assert.equal(userOnlyIconForSupport(false), FALLBACK_USER_ICON);
	assert.equal(FONT_AWESOME_USER_ICON, "\uf007");
	assert.equal(FALLBACK_USER_ICON, "ⓤ");
	assert.equal(BLOCKED_ICON, "⊘");

	assert.equal(detectNerdFontSupport({ PI_SKILL_CONTROL_NERD_FONT: "1" }, () => undefined), true);
	assert.equal(detectNerdFontSupport({ PI_SKILL_CONTROL_NERD_FONT: "0" }, () => "Hack Nerd Font"), false);
	assert.equal(
		detectNerdFontSupport(
			{ GHOSTTY_BIN_DIR: "/ghostty" },
			(file) => (file === "/ghostty/ghostty" ? "font-family = Hack Nerd Font Mono" : undefined),
		),
		true,
	);
	assert.equal(
		detectNerdFontSupport({}, (file) => (file === "fc-list" ? "Font Awesome 6 Free" : undefined)),
		true,
	);
	assert.equal(detectNerdFontSupport({}, () => "Menlo"), false);
});

test("legacy disabledPaths migrate to v5 blocked paths", () => {
	const skill = makeSkill("legacy-disabled");
	for (const version of [1, 2, 4]) {
		const directory = join(skillRoot, `legacy-v${version}`);
		const configPath = join(directory, "skill-control.json");
		mkdirSync(directory, { recursive: true });
		writeFileSync(configPath, `${JSON.stringify({ version, disabledPaths: [skill.filePath] })}\n`, "utf8");

		const loaded = readPolicyConfig(configPath);
		assert.equal(loaded.migrated, true);
		assert.equal(loaded.blockedPaths.has(realpathSync.native(skill.filePath)), true);

		writePolicyConfig(configPath, loaded.blockedPaths);
		const persisted = JSON.parse(readFileSync(configPath, "utf8"));
		assert.equal(persisted.version, 5);
		assert.deepEqual(persisted.blockedPaths, [realpathSync.native(skill.filePath)]);

		const reloaded = readPolicyConfig(configPath);
		assert.equal(reloaded.migrated, false);
		assert.equal(reloaded.blockedPaths.has(realpathSync.native(skill.filePath)), true);
	}
});

test("v3 partial invocation overrides migrate conservatively to Blocked", () => {
	const configPath = join(skillRoot, "legacy-v3", "skill-control.json");
	mkdirSync(join(skillRoot, "legacy-v3"), { recursive: true });
	const commandOnly = makeSkill("legacy-command-only");
	const fullyOpen = makeSkill("legacy-fully-open");
	writeFileSync(
		configPath,
		`${JSON.stringify({
			version: 3,
			overrides: {
				[commandOnly.filePath]: { model: false, user: true },
				[fullyOpen.filePath]: { model: true, user: true },
			},
		})}\n`,
		"utf8",
	);

	const loaded = readPolicyConfig(configPath);
	assert.equal(loaded.migrated, true);
	assert.equal(loaded.blockedPaths.has(realpathSync.native(commandOnly.filePath)), true);
	assert.equal(loaded.blockedPaths.has(realpathSync.native(fullyOpen.filePath)), false);
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
		label: ".agents (~/.agents/skills)",
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

test("classifySkillSource recognizes every supported tool root", () => {
	const home = skillRoot;
	const agentDir = join(home, ".pi", "agent");
	const cases = [
		["pi", join(agentDir, "skills"), "Pi (~/.pi/agent/skills)"],
		["claude", join(home, ".claude", "skills"), "Claude (~/.claude/skills)"],
		["codex", join(home, ".codex", "skills"), "Codex (~/.codex/skills)"],
		["opencode", join(home, ".config", "opencode", "skills"), "OpenCode (~/.config/opencode/skills)"],
		["gemini", join(home, ".gemini", "skills"), "Gemini (~/.gemini/skills)"],
		["antigravity", join(home, ".gemini", "config", "skills"), "Antigravity (~/.gemini/config/skills)"],
		["cursor", join(home, ".cursor", "skills"), "Cursor (~/.cursor/skills)"],
		["trae", join(home, ".trae", "skills"), "Trae (~/.trae/skills)"],
		["grok", join(home, ".grok", "skills"), "Grok (~/.grok/skills)"],
		["kimi", join(home, ".kimi-code", "skills"), "Kimi Code (~/.kimi-code/skills)"],
	];

	for (const [kind, root, label] of cases) {
		const skill = makeSkill(`from-${kind}`, { dir: join(root, `from-${kind}`) });
		assert.deepEqual(classifySkillSource(skill, home, agentDir, home), { kind, label });
	}
});

test("classifySkillSource recognizes Kimi Code project and custom home roots", () => {
	const home = skillRoot;
	const agentDir = join(home, ".pi", "agent");
	const projectSkill = makeSkill("kimi-project", {
		dir: join(home, "workspace", ".kimi-code", "skills", "kimi-project"),
		scope: "project",
	});
	const customHome = join(home, "custom-kimi-home");
	const customHomeSkill = makeSkill("kimi-custom-home", {
		dir: join(customHome, "skills", "kimi-custom-home"),
	});

	assert.deepEqual(classifySkillSource(projectSkill, home, agentDir, home), {
		kind: "kimi",
		label: "Kimi Code (project)",
	});
	assert.deepEqual(classifySkillSource(customHomeSkill, home, agentDir, home, customHome), {
		kind: "kimi",
		label: "Kimi Code (~/custom-kimi-home/skills)",
	});
});

test("source classification preserves a tool symlink entry instead of its shared target", () => {
	const home = skillRoot;
	const target = makeSkill("shared-through-trae", {
		dir: join(home, ".agents", "skills", "shared-through-trae"),
	});
	const linkedDir = join(home, ".trae", "skills", "shared-through-trae");
	mkdirSync(join(home, ".trae", "skills"), { recursive: true });
	symlinkSync(target.baseDir, linkedDir, "dir");
	const linkedPath = join(linkedDir, "SKILL.md");
	const viaTrae = {
		...target,
		filePath: linkedPath,
		baseDir: linkedDir,
		sourceInfo: { ...target.sourceInfo, path: linkedPath, baseDir: linkedDir },
	};

	assert.deepEqual(classifySkillSource(viaTrae, home, join(home, ".pi", "agent"), home), {
		kind: "trae",
		label: "Trae (~/.trae/skills)",
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

function terminalText(text) {
	return text.replaceAll(CURSOR_MARKER, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function makePanelItem(name, sourceKind, sourceLabel, options = {}) {
	const path = options.path ?? `/skills/${name}/SKILL.md`;
	const scannedPath = options.scannedPath ?? path;
	return {
		path,
		scannedPath,
		name,
		label: options.label ?? path,
		scannedLabel: options.scannedLabel ?? scannedPath,
		description: options.description ?? `${name} description`,
		sourceKind,
		sourceLabel,
		configurationLevel: options.configurationLevel ?? "global",
		content: options.content ?? `# ${name}\n`,
		nativeAvailability: options.nativeAvailability ?? { modelVisible: true, commandAvailable: true },
	};
}

function makePanel(onDone = () => undefined, options = {}) {
	const items = options.items ?? [
		makePanelItem("agents-both", "agents", ".agents (~/.agents/skills)"),
		makePanelItem("agents-user", "agents", ".agents (~/.agents/skills)", {
			nativeAvailability: { modelVisible: false, commandAvailable: true },
		}),
		makePanelItem("agents-project", "agents", ".agents (project)", {
			configurationLevel: "project",
		}),
		makePanelItem("package-skill", "package", "Package (example-pkg)"),
		makePanelItem("settings-model", "settings", "Settings (user)"),
		makePanelItem("cli-skill", "cli", "CLI (--skill)", {
			configurationLevel: "temporary",
		}),
	];
	return new SkillControlPanel({
		tui: { terminal: { rows: options.rows ?? 80 }, requestRender() {} },
		theme: options.theme ?? plainTheme,
		keybindings: {
			matches: (data, action) =>
				(action === "tui.select.up" && data === "UP") ||
				(action === "tui.select.down" && data === "DOWN") ||
				(action === "tui.select.confirm" && data === "ENTER") ||
				(action === "tui.select.cancel" && data === "ESC"),
		},
		items,
		blockedPaths: new Set([
			"/skills/settings-model/SKILL.md",
			"/skills/agents-project/SKILL.md",
		]),
		userOnlyIcon: options.userOnlyIcon ?? FALLBACK_USER_ICON,
		onApply: options.onApply ?? (() => undefined),
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

function filterHeaderLine(panel, width = 120) {
	const lines = panel.render(width);
	const sectionIndex = lines.findIndex((line) => /^├─ Skills \d/.test(terminalText(line)));
	const rawLine =
		lines.find((line) => line.includes(CURSOR_MARKER)) ??
		lines.find((line) => terminalText(line).includes("[/] source")) ??
		(sectionIndex > 0 ? lines[sectionIndex - 1] : undefined);
	assert.ok(rawLine);
	return terminalText(rawLine);
}

test("panel uses a source-first compact header without Extra scan", () => {
	const panel = makePanel();
	const output = terminalText(panel.render(120).join("\n"));

  assert.match(output, /Skills 6 · model 5 · ⓤ 1 · ⊘ 2/);
	assert.match(output, /\[ALL 6\]\s+\.agents 3\s+Package 1\s+Settings 1\s+CLI 1\s+11 empty sources/);
	assert.match(output, /\/ filter all skills\s+\[\/\] source/);
	assert.doesNotMatch(output, /Native\s+5 Model \+ \/skill|Policy\s+⊘ 2|Sources\s+\[ALL 6\]|Filter\s+\//);
	assert.doesNotMatch(output, /\bAvailability\b/);
	assert.doesNotMatch(output, /[●◑○◆]|Model only|User only|Manual only|Disabled/);
	assert.doesNotMatch(output, /\bPi 0\b|\bClaude 0\b|\bKimi Code 0\b|\bZed 0\b/);
	assert.doesNotMatch(output, /Extra scan|Claude off|Codex off/);
});

test("source strip keeps non-empty tools and collapses zero-count tools", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("shared-skill", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("grok-skill", "grok", "Grok (~/.grok/skills)"),
		],
	});
	const output = terminalText(panel.render(120).join("\n"));

	assert.ok(output.indexOf("[ALL 2]") < output.indexOf(".agents 1"));
	assert.ok(output.indexOf(".agents 1") < output.indexOf("Grok 1"));
	assert.ok(output.indexOf("Grok 1") < output.indexOf("10 empty sources"));
	assert.doesNotMatch(output, /\bPi 0\b|\bKimi Code 0\b|\bZed 0\b/);
});

test("a specific source groups Skills by configuration level", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("project-skill", "claude", "Claude (project)", {
				configurationLevel: "project",
			}),
			makePanelItem("global-one", "claude", "Claude (~/.claude/skills)"),
			makePanelItem("temporary-skill", "claude", "Claude (temporary)", {
				configurationLevel: "temporary",
			}),
			makePanelItem("global-two", "claude", "Claude (~/.claude/skills)"),
		],
	});
	panel.render(120);
	panel.handleInput("]");
	const list = wideList(panel);

	for (const expected of ["Global (2)", "Project (1)", "Temporary (1)"]) {
		assert.ok(list.includes(expected), `missing configuration-level group: ${expected}`);
	}
	assert.ok(list.indexOf("Global (2)") < list.indexOf("global-one"));
	assert.ok(list.indexOf("global-two") < list.indexOf("Project (1)"));
	assert.ok(list.indexOf("Project (1)") < list.indexOf("project-skill"));
	assert.ok(list.indexOf("project-skill") < list.indexOf("Temporary (1)"));
	assert.ok(list.indexOf("Temporary (1)") < list.indexOf("temporary-skill"));
});

test("configuration-level groups survive filtering and keep scope precedence", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("global-scope-query-result", "claude", "Claude (~/.claude/skills)"),
			makePanelItem("project-scope-query", "claude", "Claude (project)", {
				configurationLevel: "project",
			}),
		],
	});
	panel.render(120);
	panel.handleInput("]");
	panel.handleInput("/");
	for (const character of "scope-query") panel.handleInput(character);
	const list = wideList(panel);

	assert.ok(list.indexOf("Global (1)") < list.indexOf("global-scope-query-result"));
	assert.ok(list.indexOf("global-scope-query-result") < list.indexOf("Project (1)"));
	assert.ok(list.indexOf("Project (1)") < list.indexOf("project-scope-query"));
});

test("a scrolled source keeps the current configuration-level header sticky", () => {
	const globals = Array.from({ length: 8 }, (_, index) =>
		makePanelItem(`global-${index}`, "claude", "Claude (~/.claude/skills)"),
	);
	const projects = Array.from({ length: 8 }, (_, index) =>
		makePanelItem(`project-${index}`, "claude", "Claude (project)", {
			configurationLevel: "project",
		}),
	);
	const panel = makePanel(() => undefined, { items: [...globals, ...projects], rows: 18 });
	panel.render(120);
	panel.handleInput("]");
	for (let index = 0; index < 11; index++) panel.handleInput("j");
	const list = wideList(panel);

	assert.match(list, /Project \(8\)/);
	assert.doesNotMatch(list, /Claude \(project\)/);
});

test("group headers are selectable and Space or Enter toggles them", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("alpha", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("beta", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("package-skill", "package", "Package (example-pkg)"),
		],
	});
	panel.render(120);

	let list = wideList(panel);
	assert.match(list, /▾ \.agents \(~\/\.agents\/skills\) \(2\)/);
	assert.match(list, /alpha/);

	panel.handleInput("k");
	assert.match(widePreview(panel), /Group\s+\.agents \(~\/\.agents\/skills\)/);
	assert.match(widePreview(panel), /State\s+Expanded/);
	panel.handleInput(" ");
	list = wideList(panel);
	assert.match(list, /▸ \.agents \(~\/\.agents\/skills\) \(2\)/);
	assert.doesNotMatch(list, /alpha|beta/);
	assert.doesNotMatch(panel.render(120).join("\n"), /Pending 1/);
	assert.match(widePreview(panel), /l to expand this group · Space\/Enter to toggle/);

	panel.handleInput(" ");
	list = wideList(panel);
	assert.match(list, /▾ \.agents \(~\/\.agents\/skills\) \(2\)/);
	assert.match(list, /alpha|beta/);

	panel.handleInput("ENTER");
	list = wideList(panel);
	assert.match(list, /▸ \.agents \(~\/\.agents\/skills\) \(2\)/);
	assert.doesNotMatch(list, /alpha|beta/);
	assert.match(list, /package-skill/);
	assert.match(widePreview(panel), /State\s+Collapsed/);
	assert.match(widePreview(panel), /l to expand this group · Space\/Enter to toggle/);

	panel.handleInput("ENTER");
	list = wideList(panel);
	assert.match(list, /▾ \.agents \(~\/\.agents\/skills\) \(2\)/);
	assert.match(list, /alpha|beta/);
	panel.handleInput("j");
	assert.match(widePreview(panel), /# alpha/);
});

test("Skill rows use a uniform child indent beneath their group headings", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("alpha", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("command-only", "agents", ".agents (~/.agents/skills)", {
				nativeAvailability: { modelVisible: false, commandAvailable: true },
			}),
		],
	});
	const lines = wideList(panel).split("\n");
	const groupLine = lines.find((line) => line.includes(".agents (~/.agents/skills)"));
	const normalSkillLine = lines.find((line) => line.includes("alpha"));
	const commandOnlySkillLine = lines.find((line) => line.includes("command-only"));
	assert.ok(groupLine);
	assert.ok(normalSkillLine);
	assert.ok(commandOnlySkillLine);
	const groupLabelColumn = groupLine.indexOf(".agents");
	const normalSkillLabelColumn = normalSkillLine.indexOf("alpha");
	const commandOnlySkillIconColumn = commandOnlySkillLine.indexOf(FALLBACK_USER_ICON);
	const commandOnlySkillLabelColumn = commandOnlySkillLine.indexOf("command-only");
	assert.equal(normalSkillLabelColumn, groupLabelColumn + 2);
	assert.equal(commandOnlySkillIconColumn, normalSkillLabelColumn);
	assert.equal(commandOnlySkillLabelColumn, commandOnlySkillIconColumn + 2);
});

test("selected background survives ANSI resets introduced by long-name truncation", () => {
	const backgroundStart = "\x1b[48;5;24m";
	const panel = makePanel(() => undefined, {
		theme: {
			...plainTheme,
			bg: (_color, text) => `${backgroundStart}${text}\x1b[49m`,
		},
		items: [
			makePanelItem(
				"improve-codebase-architecture-with-a-long-name",
				"agents",
				".agents (~/.agents/skills)",
			),
		],
	});
	const selectedLine = panel.render(120).find((line) => line.includes(backgroundStart));
	assert.ok(selectedLine);
	const fullResetCount = [...selectedLine.matchAll(/\x1b\[0m/g)].length;
	const backgroundStartCount = selectedLine.split(backgroundStart).length - 1;

	assert.ok(fullResetCount > 0, "fixture must exercise ANSI-aware truncation");
	assert.equal(backgroundStartCount, fullResetCount + 1);
});

test("h collapses and l expands a selected group without moving focus", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("alpha", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("beta", "agents", ".agents (~/.agents/skills)"),
		],
	});
	panel.render(120);
	panel.handleInput("k");

	let output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /h collapse\s+l expand/);
	assert.doesNotMatch(output, /h\/l focus/);
	panel.handleInput("h");
	assert.match(wideList(panel), /▸ \.agents \(~\/\.agents\/skills\) \(2\)/);
	assert.match(widePreview(panel), /State\s+Collapsed/);

	panel.handleInput("h");
	assert.match(wideList(panel), /▸ \.agents \(~\/\.agents\/skills\) \(2\)/);
	panel.handleInput("l");
	assert.match(wideList(panel), /▾ \.agents \(~\/\.agents\/skills\) \(2\)/);
	panel.handleInput("l");
	assert.match(wideList(panel), /▾ \.agents \(~\/\.agents\/skills\) \(2\)/);

	panel.handleInput("j");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /h\/l focus/);
	assert.doesNotMatch(output, /h collapse\s+l expand/);
	panel.handleInput("l");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(output, /PgUp\/PgDn scroll/);
});

test("a specific Source folds configuration levels independently", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("global-one", "claude", "Claude (~/.claude/skills)"),
			makePanelItem("global-two", "claude", "Claude (~/.claude/skills)"),
			makePanelItem("project-one", "claude", "Claude (project)", {
				configurationLevel: "project",
			}),
		],
	});
	panel.render(120);
	panel.handleInput("]");
	panel.handleInput("k");
	panel.handleInput("ENTER");

	let list = wideList(panel);
	assert.match(list, /▸ Global \(2\)/);
	assert.doesNotMatch(list, /global-one|global-two/);
	assert.match(list, /▾ Project \(1\)/);
	assert.match(list, /project-one/);

	panel.handleInput("[");
	panel.handleInput("]");
	list = wideList(panel);
	assert.match(list, /▸ Global \(2\)/);
	assert.doesNotMatch(list, /global-one|global-two/);
});

test("filtering temporarily expands matching groups and clearing restores folds", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("alpha", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("beta", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("package-skill", "package", "Package (example-pkg)"),
		],
	});
	panel.render(120);
	panel.handleInput("k");
	panel.handleInput("ENTER");
	assert.doesNotMatch(wideList(panel), /alpha|beta/);

	panel.handleInput("/");
	for (const character of "alpha") panel.handleInput(character);
	let list = wideList(panel);
	assert.match(list, /▾ \.agents \(~\/\.agents\/skills\) \(1\)/);
	assert.match(list, /alpha/);
	panel.handleInput("ENTER");
	panel.handleInput("ESC");

	list = wideList(panel);
	assert.match(list, /▸ \.agents \(~\/\.agents\/skills\) \(2\)/);
	assert.doesNotMatch(list, /alpha|beta/);
});

test("wide preview shows the selected path before the Skill body without redundant metadata", () => {
	const panel = makePanel();
	const preview = widePreview(panel);

	assert.match(preview, /Path\s+\/skills\/agents-both\/SKILL\.md/);
	assert.match(preview, /Native Model \+ \/skill · Effective Model \+ \/skill · Unblocked/);
	assert.match(preview, /# agents-both/);
	assert.ok(preview.indexOf("/skills/agents-both/SKILL.md") < preview.indexOf("Native Model + /skill"));
	assert.ok(preview.indexOf("Native Model + /skill") < preview.indexOf("# agents-both"));
	assert.doesNotMatch(
		preview,
		/agents-both description|Access from|Agents \(user\)|\d+ lines|\d+ (?:B|KB|MB)|tokens|View|wrapped rows/,
	);
});

test("wide preview shows both the scanned entry and canonical target for a symlinked Skill", () => {
	const scannedPath = "/home/example/.agents/skills/zine/SKILL.md";
	const targetPath = "/home/example/code/zine/SKILL.md";
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("zine", "agents", ".agents (~/.agents/skills)", {
				path: targetPath,
				scannedPath,
				label: "~/code/zine/SKILL.md",
				scannedLabel: "~/.agents/skills/zine/SKILL.md",
			}),
		],
	});
	const preview = widePreview(panel);

	assert.match(preview, /Scanned\s+~\/\.agents\/skills\/zine\/SKILL\.md/);
	assert.match(preview, /Target\s+~\/code\/zine\/SKILL\.md\s+\(symlink\)/);
	assert.ok(preview.indexOf("Scanned") < preview.indexOf("Target"));
	assert.ok(preview.indexOf("Target") < preview.indexOf("Native Model + /skill"));
	assert.doesNotMatch(preview, /Path\s+~\/code\/zine\/SKILL\.md/);
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
	const item = makePanelItem("highlighted", "agents", ".agents (~/.agents/skills)", {
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

test("Skill rows show only the user-only and blocked exceptions", () => {
	const panel = makePanel();
	panel.render(120);

	assert.doesNotMatch(listLine(panel, "agents-both"), /[ⓤ⊘]|\b(?:Unblocked|Blocked|Pending)\b/);
	assert.match(listLine(panel, "agents-user"), /ⓤ/);
	assert.doesNotMatch(listLine(panel, "agents-user"), /[⊘]|\b(?:Unblocked|Blocked|Pending)\b/);
	assert.match(listLine(panel, "agents-project"), /⊘/);
	assert.match(listLine(panel, "settings-model"), /⊘/);
	assert.doesNotMatch(listLine(panel, "agents-project"), /\bBlocked\b/);
	assert.doesNotMatch(wideList(panel), /Override|Pending/);
	assert.match(widePreview(panel), /Native Model \+ \/skill · Effective Model \+ \/skill · Unblocked/);

	panel.handleInput("j");
	panel.handleInput("j");
	panel.handleInput("j");
	assert.match(widePreview(panel), /Native Model \+ \/skill · Effective Blocked · Blocked by policy/);
	panel.handleInput(" ");
	assert.match(listLine(panel, "agents-project"), /Pending/);
	assert.match(widePreview(panel), /Native Model \+ \/skill · Effective Model \+ \/skill · Pending unblock/);
	panel.handleInput("u");
	assert.match(listLine(panel, "agents-project"), /⊘/);
	assert.match(widePreview(panel), /Native Model \+ \/skill · Effective Blocked · Blocked by policy/);
});

test("Skill rows use the Font Awesome user glyph with a one-cell label gap", () => {
	const panel = makePanel(() => undefined, { userOnlyIcon: FONT_AWESOME_USER_ICON });
	const lines = panel.render(48);

	assert.match(listLine(panel, "agents-user"), / agents-user/);
	assert.doesNotMatch(listLine(panel, "agents-user"), /ⓤ/);
	assert.ok(lines.every((line) => visibleWidth(line) === 48));
});

test("wide footer follows the focused pane", () => {
	const panel = makePanel();
	let output = panel.render(120).join("\n");

	assert.match(
		output,
		/j\/k select\s+h\/l focus\s+\[\/\] source\s+\/ filter\s+Space toggle\s+r unblock\s+u undo/,
	);
	assert.doesNotMatch(output, /PgUp\/PgDn scroll/);

	panel.handleInput("\t");
	output = panel.render(120).join("\n");
	assert.match(output, /j\/k\/PgUp\/PgDn scroll\s+h\/l focus\s+\[\/\] source\s+\/ filter/);
	assert.doesNotMatch(output, /Type filter|j\/k select|Space toggle/);

	panel.handleInput("\t");
	output = panel.render(120).join("\n");
	assert.match(output, /j\/k select\s+h\/l focus\s+\[\/\] source/);
});

test("narrow layouts keep the selected path and cycle focus with h/l", () => {
	const panel = makePanel();
	let output = panel.render(48).join("\n");
	assert.match(output, /\/skills\/agents-both\/SKILL\.md/);
	assert.doesNotMatch(output, /Skill default|Saved setting/);

	panel.handleInput("l");
	output = panel.render(48).join("\n");
	assert.match(output, /Skill preview/);
	assert.match(output, /\/skills\/agents-both\/SKILL\.md/);
	assert.match(output, /Native Model \+ \/skill · Effective Model \+/);
	assert.match(output, /# agents-both/);
	assert.doesNotMatch(output, /agents-both description|Access from|Agents \(user\)|\d+ lines|\d+ (?:B|KB|MB)|tokens|View|wrapped rows/);

	panel.handleInput("l");
	assert.doesNotMatch(panel.render(48).join("\n"), /Skill preview/);
	panel.handleInput("h");
	assert.match(panel.render(48).join("\n"), /Skill preview/);
});

test("narrow layouts show both paths for a symlinked Skill", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("zine", "agents", ".agents (~/.agents/skills)", {
				path: "/home/example/code/zine/SKILL.md",
				scannedPath: "/home/example/.agents/skills/zine/SKILL.md",
				label: "~/code/zine/SKILL.md",
				scannedLabel: "~/.agents/skills/zine/SKILL.md",
			}),
		],
	});

	let output = terminalText(panel.render(60).join("\n"));
	assert.match(output, /Scanned\s+~\/\.agents\/skills\/zine\/SKILL\.md/);
	assert.match(output, /Target\s+~\/code\/zine\/SKILL\.md \(symlink\)/);

	panel.handleInput("l");
	output = terminalText(panel.render(60).join("\n"));
	assert.match(output, /Scanned\s+~\/\.agents\/skills\/zine\/SKILL\.md/);
	assert.match(output, /Target\s+~\/code\/zine\/SKILL\.md \(symlink\)/);
});

test("narrow layout shows the selected group's fold state and action", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("alpha", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("beta", "agents", ".agents (~/.agents/skills)"),
		],
	});
	panel.render(60);
	panel.handleInput("k");
	panel.handleInput("ENTER");
	panel.handleInput("j");
	const output = terminalText(panel.render(60).join("\n"));

	assert.match(output, /▸ \.agents \(~\/\.agents\/skills\) \(2\)/);
	assert.match(output, /Group\s+\.agents \(~\/\.agents\/skills\)/);
	assert.match(output, /2 skills · Collapsed/);
	assert.match(output, /l to expand this group · Space\/Enter to toggle/);
	assert.match(output, /h collapse\s+l expand\s+Space\/Enter toggle/);
	assert.doesNotMatch(output, /alpha|beta/);
});

test("filter input requires slash, hides the trigger, and treats hjkl as query text", () => {
	const panel = makePanel();
	panel.focused = true;
	panel.render(120);
	for (const character of "abc") panel.handleInput(character);
	let output = terminalText(panel.render(120).join("\n"));

	assert.match(filterHeaderLine(panel), /\/ filter all skills\s+\[\/\] source/);
	assert.match(output, /agents-both/);

	panel.handleInput("/");
	for (const character of "skill") panel.handleInput(character);
	const rendered = panel.render(120).join("\n");
	output = terminalText(rendered);

	assert.ok(rendered.includes(CURSOR_MARKER));
	assert.match(filterHeaderLine(panel), /skill/);
	assert.doesNotMatch(filterHeaderLine(panel), /\/skill/);
  assert.match(output, /Skills 2 · model 2 · ⓤ 0 · ⊘ 0/);
	assert.match(output, /cli-skill/);
	assert.match(output, /Type filter\s+←\/→ cursor\s+↑\/↓ select\s+Ctrl\+U clear\s+Ctrl\+W word/);
});

test("filter input supports cursor editing, paste, and command-line deletion keys", () => {
	const panel = makePanel();
	panel.focused = true;
	panel.render(120);
	panel.handleInput("/");
	panel.handleInput("skll");
	panel.handleInput("\x1b[D");
	panel.handleInput("\x1b[D");
	panel.handleInput("i");
	panel.handleInput("\x1b[F");
	panel.handleInput("\x1b[200~-中文\x1b[201~");
	let output = terminalText(panel.render(120).join("\n"));
	assert.match(filterHeaderLine(panel), /skill-中文/);

	panel.handleInput("\x15");
	panel.handleInput("alpha beta");
	panel.handleInput("\x17");
	panel.handleInput("ENTER");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(filterHeaderLine(panel), /\/ alpha\s+\[\/\] source/);
	assert.doesNotMatch(output, /beta/);

	panel.handleInput("/");
	panel.handleInput("x");
	panel.handleInput("\x08");
	panel.handleInput("\x15");
	panel.handleInput("skill");
	panel.handleInput("ENTER");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(filterHeaderLine(panel), /\/ skill\s+\[\/\] source/);
	assert.match(output, /cli-skill/);
});

test("h/l cycle focus while j/k follow the focused pane", () => {
	const items = [
		makePanelItem("first", "agents", ".agents (~/.agents/skills)", {
			content: Array.from({ length: 40 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`).join("\n"),
		}),
		makePanelItem("second", "agents", ".agents (~/.agents/skills)"),
	];
	const panel = makePanel(() => undefined, { items });
	panel.render(120);

	panel.handleInput("j");
	assert.match(widePreview(panel), /\/skills\/second\/SKILL\.md/);
	panel.handleInput("k");
	assert.match(widePreview(panel), /\/skills\/first\/SKILL\.md/);

	panel.handleInput("l");
	assert.match(panel.render(120).join("\n"), /j\/k\/PgUp\/PgDn scroll\s+h\/l focus/);
	const beforeScroll = widePreview(panel);
	panel.handleInput("j");
	assert.notEqual(widePreview(panel), beforeScroll);

	panel.handleInput("l");
	assert.match(panel.render(120).join("\n"), /j\/k select\s+h\/l focus/);
	panel.handleInput("h");
	assert.match(panel.render(120).join("\n"), /j\/k\/PgUp\/PgDn scroll\s+h\/l focus/);
	panel.handleInput("h");
	assert.match(panel.render(120).join("\n"), /j\/k select\s+h\/l focus/);
});

test("[/] cycle source filters in both directions", () => {
	const panel = makePanel();
	panel.render(120);

	for (const [expected, scope] of [
		[".agents 3", ".agents"],
		["Package 1", "Package"],
		["Settings 1", "Settings"],
		["CLI 1", "CLI"],
		["ALL 6", "all skills"],
	]) {
		panel.handleInput("]");
		assert.match(panel.render(120).join("\n"), new RegExp(`\\[${expected}\\]`));
		assert.match(filterHeaderLine(panel), new RegExp(`/ filter ${scope === "all skills" ? scope : `within ${scope}`}`));
	}
	panel.handleInput("[");
	assert.match(panel.render(120).join("\n"), /\[CLI 1\]/);
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
	let output = terminalText(panel.render(120).join("\n"));

	assert.match(filterHeaderLine(panel), /\/ skill\s+\[\/\] source/);
	assert.doesNotMatch(filterHeaderLine(panel), /\/skill/);
	assert.match(output, /j\/k select\s+h\/l focus\s+\[\/\] source\s+\/ filter/);

	panel.handleInput("/");
	panel.handleInput("x");
	assert.match(filterHeaderLine(panel), /skillx/);
	panel.handleInput("ESC");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(filterHeaderLine(panel), /\/ skill\s+\[\/\] source/);
	assert.doesNotMatch(output, /skillx/);

	panel.handleInput("ESC");
	output = terminalText(panel.render(120).join("\n"));
	assert.match(filterHeaderLine(panel), /\/ filter all skills\s+\[\/\] source/);
	assert.equal(result, undefined);

	panel.handleInput("ESC");
	assert.deepEqual(result, { action: "close" });
});

test("filter input takes precedence over focus and source shortcuts", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("]");
	panel.handleInput("l");
	panel.handleInput("/");
	for (const character of "hl[] ?") panel.handleInput(character);
	const output = terminalText(panel.render(120).join("\n"));

	assert.match(output, /ALL 6\s+\[\.agents 3\]/);
	assert.match(filterHeaderLine(panel), /hl\[\] \?/);
	assert.match(output, /Type filter\s+←\/→ cursor\s+↑\/↓ select/);
	assert.doesNotMatch(output, /Skill routes and policy|Pending 1/);
});

test("Space toggles between Unblocked and Blocked", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput(" ");
	let output = panel.render(120).join("\n");
	assert.match(listLine(panel, "agents-both"), /Pending/);
	assert.doesNotMatch(listLine(panel, "agents-both"), /⊘/);
  assert.match(output, /Skills 6 · model 5 · ⓤ 1 · ⊘ 3 · △ 1/);
	assert.match(output, /Unblocked → Blocked · Pending 1/);

	panel.handleInput(" ");
	output = panel.render(120).join("\n");
	assert.doesNotMatch(listLine(panel, "agents-both"), /\b(?:Unblocked|Blocked|Pending)\b/);
	assert.match(output, /Blocked → Unblocked · No pending changes/);
});

test("Shift+Space also toggles while r unblocks and u undoes", () => {
	const panel = makePanel();
	panel.render(120);

	panel.handleInput("\x1b[32;2u");
	let output = panel.render(120).join("\n");
	assert.match(output, /Unblocked → Blocked · Pending 1/);
	assert.match(listLine(panel, "agents-both"), /Pending/);

	panel.handleInput("u");
	output = panel.render(120).join("\n");
	assert.match(output, /Undo agents-both: Blocked → Unblocked/);
	assert.doesNotMatch(listLine(panel, "agents-both"), /\b(?:Unblocked|Blocked|Pending)\b/);

	panel.handleInput(" ");
	panel.handleInput("r");
	output = panel.render(120).join("\n");
	assert.match(output, /Blocked → Unblocked · No pending changes/);
	assert.doesNotMatch(listLine(panel, "agents-both"), /\b(?:Unblocked|Blocked|Pending)\b/);

	panel.handleInput("u");
	output = panel.render(120).join("\n");
	assert.match(output, /Undo agents-both: Unblocked → Blocked/);
	assert.match(listLine(panel, "agents-both"), /Pending/);
});

test("unblocking removes a saved blocked path", () => {
	let applied;
	const panel = makePanel(() => undefined, {
		onApply(value) {
			applied = value;
		},
	});
	panel.render(120);
	for (let index = 0; index < 7; index++) panel.handleInput("DOWN");
	panel.handleInput(" ");

	const output = panel.render(120).join("\n");
	assert.match(listLine(panel, "settings-model"), /Pending/);
	assert.match(output, /Blocked → Unblocked · Pending 1/);

	panel.handleInput("\x13");
	assert.equal(applied.has("/skills/settings-model/SKILL.md"), false);
	assert.doesNotMatch(panel.render(120).join("\n"), /Pending 1/);
});


test("Ctrl+S applies changes without closing and establishes a new editing baseline", () => {
	let closeResult;
	const applied = [];
	const panel = makePanel((value) => {
		closeResult = value;
	}, {
		onApply(value) {
			applied.push(value);
		},
	});
	panel.render(120);
	panel.handleInput("\x13");
	assert.equal(closeResult, undefined);
	assert.equal(applied.length, 0);
	assert.match(panel.render(120).join("\n"), /No pending changes/);

	panel.handleInput(" ");

	assert.equal(closeResult, undefined);
	assert.equal(applied.length, 0);
	assert.match(panel.render(120).join("\n"), /Pending 1/);
	panel.handleInput("\x13");
	assert.equal(closeResult, undefined);
	assert.equal(applied.length, 1);
	assert.equal(applied[0].has("/skills/agents-both/SKILL.md"), true);
	let output = panel.render(120).join("\n");
	assert.doesNotMatch(output, /Pending 1/);
	assert.match(output, /Applied 1 Skill change/);
	assert.match(listLine(panel, "agents-both"), /⊘/);

	panel.handleInput("j");
	panel.handleInput(" ");
	output = panel.render(120).join("\n");
	assert.match(output, /Pending 1/);
	panel.handleInput("\x13");
	assert.equal(closeResult, undefined);
	assert.equal(applied.length, 2);
	assert.equal(applied[1].has("/skills/agents-user/SKILL.md"), true);
	assert.doesNotMatch(panel.render(120).join("\n"), /Pending 1/);
	assert.match(listLine(panel, "agents-user"), /ⓤ.*⊘/);

	panel.handleInput("ESC");
	assert.deepEqual(closeResult, { action: "close" });
});

test("Ctrl+S keeps pending changes when applying fails", () => {
	let closeResult;
	let applyAttempts = 0;
	const panel = makePanel((value) => {
		closeResult = value;
	}, {
		onApply() {
			applyAttempts++;
			throw new Error("Could not write Skill control configuration");
		},
	});
	panel.render(120);
	panel.handleInput(" ");
	panel.handleInput("\x13");

	const output = panel.render(120).join("\n");
	assert.equal(closeResult, undefined);
	assert.equal(applyAttempts, 1);
	assert.match(listLine(panel, "agents-both"), /Pending/);
	assert.match(output, /Could not write Skill control configuration/);
	panel.handleInput("ESC");
	assert.match(panel.render(120).join("\n"), /Discard 1 pending change/);
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

test("the routes guide separates native invocation from blocking policy", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("?");
	let output = panel.render(120).join("\n");

	assert.match(output, /Skill routes and policy/);
	assert.match(output, /Pi defines native invocation routes\. Skill Control applies a separate blocking policy\./);
	assert.match(output, /Native routes\s+Model sees\s+\/skill/);
	assert.match(output, /Model \+ \/skill\s+✓\s+✓/);
	assert.match(output, /ⓤ\s+\/skill only\s+—\s+✓/);
	assert.match(output, /Policy/);
	assert.match(output, /⊘\s+Both routes unavailable\s+—\s+—/);
	assert.match(output, /Unblocked preserves the native routes shown above\./);
	assert.doesNotMatch(output, /Model only|Neither|Enter choose|Save for/);

	panel.handleInput(" ");
	output = panel.render(120).join("\n");
	assert.match(output, /Skill routes and policy/);

	panel.handleInput("ESC");
	output = panel.render(120).join("\n");
	assert.match(listLine(panel, "agents-both"), /agents-both/);
	assert.doesNotMatch(listLine(panel, "agents-both"), /\b(?:Unblocked|Blocked|Pending)\b/);
});

test("Space does not change policy while Preview is focused", () => {
	const panel = makePanel();
	panel.render(120);
	panel.handleInput("\t");
	panel.handleInput(" ");
	panel.handleInput("\t");
	const output = panel.render(120).join("\n");

	assert.match(listLine(panel, "agents-both"), /agents-both/);
	assert.doesNotMatch(listLine(panel, "agents-both"), /\b(?:Unblocked|Blocked|Pending)\b/);
	assert.doesNotMatch(output, /Pending 1/);
});

test("panel wraps the compact header and guide within narrow terminals", () => {
	const width = 48;
	const panel = makePanel();
	panel.focused = true;
	let lines = panel.render(width);
	let output = terminalText(lines.join("\n"));
	assert.ok(lines.every((line) => visibleWidth(line) === width));
	for (const expected of [
		"[ALL 6]",
		".agents 3",
		"Package 1",
		"11 empty sources",
		"/ filter all skills",
		"[/] source",
    "Skills 6 · model 5 · ⓤ 1 · ⊘ 2",
	]) {
		assert.ok(output.includes(expected), `missing narrow header content: ${expected}`);
	}
	assert.doesNotMatch(output, /Native\s+5 Model \+ \/skill|Policy\s+⊘ 2|Sources\s+\[ALL 6\]|Filter\s+\//);

	panel.handleInput("/");
	lines = panel.render(width);
	output = terminalText(lines.join("\n"));
	assert.ok(lines.every((line) => visibleWidth(line) === width));
	assert.doesNotMatch(filterHeaderLine(panel, width), /\[\/\] source/);
	assert.match(output, /Type filter\s+Enter keep\s+Esc cancel/);

	panel.handleInput("ESC");
	panel.handleInput("?");
	lines = panel.render(width);
	output = terminalText(lines.join("\n"));
	assert.ok(lines.every((line) => visibleWidth(line) === width));
	assert.match(output, /Skill routes and policy/);
});

test("search fuzzy-matches non-contiguous name segments", () => {
	const panel = new SkillControlPanel({
		tui: { terminal: { rows: 80 }, requestRender() {} },
		theme: plainTheme,
		keybindings: { matches: () => false },
		items: [
			makePanelItem("my-pptx-html-local", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("my-pptx-local", "agents", ".agents (~/.agents/skills)"),
		],
		blockedPaths: new Set(),
		onApply: () => undefined,
		onDone: () => undefined,
	});
	panel.render(120);
	panel.handleInput("/");
	for (const character of "my-html") panel.handleInput(character);
	const output = terminalText(panel.render(120).join("\n"));

	assert.match(filterHeaderLine(panel), /my-html/);
	assert.doesNotMatch(filterHeaderLine(panel), /\/my-html/);
	assert.match(output, /my-pptx-html-local/);
	assert.doesNotMatch(output, /my-pptx-local/);
	assert.doesNotMatch(output, /No skills match/);
});

test("search follows Codex by fuzzy-matching Skill names only", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("implement", "agents", ".agents (~/.agents/skills)", {
				description: "Implement a piece of work based on a spec or set of tickets.",
			}),
			makePanelItem("improve-codebase-architecture", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("alfheim-upgrade", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("gc-minimal-zine-poster-v0-1", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("my-bruno-postman", "agents", ".agents (~/.agents/skills)", {
				description: "Move, import, or convert Bruno requests into Postman.",
			}),
			makePanelItem("codebase-design", "agents", ".agents (~/.agents/skills)", {
				description: "Design or improve a module interface.",
			}),
			makePanelItem("my-ui-structure-json", "agents", ".agents (~/.agents/skills)", {
				description: "Translate UI into a simple Chinese JSON tree.",
			}),
			makePanelItem("neutral-skill", "agents", "Imp source", {
				description: "Import metadata only.",
				path: "/imp/neutral-skill/SKILL.md",
				scannedPath: "/imp/neutral-skill/SKILL.md",
				label: "/imp/neutral-skill/SKILL.md",
				scannedLabel: "/imp/neutral-skill/SKILL.md",
			}),
		],
	});
	panel.render(120);
	panel.handleInput("/");
	for (const character of "imp") panel.handleInput(character);
	const list = wideList(panel);

	assert.match(list, /\.agents \(~\/\.agents\/skills\) \(4\)/);
	for (const expected of ["implement", "improve-codebase", "alfheim-upgrade", "gc-minimal-zine"]) {
		assert.ok(list.includes(expected), `missing Codex-style name match: ${expected}`);
	}
	for (const unexpected of ["my-bruno-postman", "codebase-design", "my-ui-structure-json", "neutral-skill", "Imp source"]) {
		assert.ok(!list.includes(unexpected), `metadata-only match leaked into results: ${unexpected}`);
	}
	assert.ok(list.indexOf("implement") < list.indexOf("improve-codebase"));
	assert.ok(list.indexOf("improve-codebase") < list.indexOf("alfheim-upgrade"));
	assert.ok(list.indexOf("alfheim-upgrade") < list.indexOf("gc-minimal-zine"));
});

test("search follows Codex subsequences without typo correction", () => {
	const panel = makePanel(() => undefined, {
		items: [
			makePanelItem("ask-better", "agents", ".agents (~/.agents/skills)", {
				description: "myboos appears only in this description.",
			}),
			makePanelItem("my-bruno-postman", "agents", ".agents (~/.agents/skills)"),
			makePanelItem("my-boss-agent-cli", "agents", ".agents (~/.agents/skills)"),
		],
	});
	panel.render(120);
	panel.handleInput("/");
	for (const character of "myboos") panel.handleInput(character);
	const list = wideList(panel);

	assert.doesNotMatch(list, /ask-better/);
	assert.match(list, /\.agents \(~\/\.agents\/skills\) \(1\)/);
	assert.match(list, /my-bruno-postman/);
	assert.doesNotMatch(list, /my-boss-agent-cli/);
});
