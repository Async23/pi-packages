import type { Skill } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";

export const CONFIG_VERSION = 3;
export const CONFIG_FILE_NAME = "skill-control.json";

export type PolicyScope = "global" | "project";
export type SkillAccessState = "enabled" | "model" | "manual" | "disabled";

export interface SkillAccess {
	model: boolean;
	user: boolean;
}

export interface SkillAccessResolution {
	access: SkillAccess;
	source: PolicyScope | "default";
}

export type SkillOverrides = Map<string, SkillAccess>;

interface SkillControlConfigV3 {
	version: typeof CONFIG_VERSION;
	overrides: Record<string, SkillAccess>;
}

interface LegacySkillControlConfig {
	version: 1 | 2;
	disabledPaths: string[];
}

export interface ReadPolicyResult {
	overrides: SkillOverrides;
	migrated: boolean;
	error?: string;
}

export const ACCESS_BY_STATE: Readonly<Record<SkillAccessState, SkillAccess>> = {
	enabled: { model: true, user: true },
	model: { model: true, user: false },
	manual: { model: false, user: true },
	disabled: { model: false, user: false },
};

export const ACCESS_STATE_ORDER: readonly SkillAccessState[] = ["enabled", "model", "manual", "disabled"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkillAccess(value: unknown): value is SkillAccess {
	return isRecord(value) && typeof value.model === "boolean" && typeof value.user === "boolean";
}

function isV3Config(value: unknown): value is SkillControlConfigV3 {
	if (!isRecord(value) || value.version !== CONFIG_VERSION || !isRecord(value.overrides)) return false;
	return Object.values(value.overrides).every(isSkillAccess);
}

function isLegacyConfig(value: unknown): value is LegacySkillControlConfig {
	return (
		isRecord(value) &&
		(value.version === 1 || value.version === 2) &&
		Array.isArray(value.disabledPaths) &&
		value.disabledPaths.every((path) => typeof path === "string")
	);
}

export function canonicalPath(filePath: string, cwd = process.cwd()): string {
	const absolutePath = normalize(resolve(cwd, filePath));
	try {
		return realpathSync.native(absolutePath);
	} catch {
		return absolutePath;
	}
}

export function cloneAccess(access: SkillAccess): SkillAccess {
	return { model: access.model, user: access.user };
}

export function cloneOverrides(overrides: ReadonlyMap<string, SkillAccess>): SkillOverrides {
	return new Map([...overrides].map(([path, access]) => [path, cloneAccess(access)]));
}

export function replaceOverrides(target: SkillOverrides, source: ReadonlyMap<string, SkillAccess>): void {
	target.clear();
	for (const [path, access] of source) target.set(path, cloneAccess(access));
}

export function skillAccessState(access: SkillAccess): SkillAccessState {
	if (access.model && access.user) return "enabled";
	if (access.model) return "model";
	if (access.user) return "manual";
	return "disabled";
}

export function accessForState(state: SkillAccessState): SkillAccess {
	return cloneAccess(ACCESS_BY_STATE[state]);
}

export function defaultSkillAccess(skill: Pick<Skill, "disableModelInvocation">): SkillAccess {
	return { model: !skill.disableModelInvocation, user: true };
}

export function resolveSkillAccess(
	path: string,
	defaultAccess: SkillAccess,
	globalOverrides: ReadonlyMap<string, SkillAccess>,
	projectOverrides: ReadonlyMap<string, SkillAccess>,
): SkillAccessResolution {
	const project = projectOverrides.get(path);
	if (project) return { access: cloneAccess(project), source: "project" };
	const global = globalOverrides.get(path);
	if (global) return { access: cloneAccess(global), source: "global" };
	return { access: cloneAccess(defaultAccess), source: "default" };
}

export function resolveUserAccess(
	path: string,
	globalOverrides: ReadonlyMap<string, SkillAccess>,
	projectOverrides: ReadonlyMap<string, SkillAccess>,
): boolean {
	return resolveSkillAccess(path, { model: true, user: true }, globalOverrides, projectOverrides).access.user;
}

export function overridesEqual(
	left: ReadonlyMap<string, SkillAccess>,
	right: ReadonlyMap<string, SkillAccess>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [path, access] of left) {
		const candidate = right.get(path);
		if (!candidate || candidate.model !== access.model || candidate.user !== access.user) return false;
	}
	return true;
}

export function changedOverrideCount(
	before: ReadonlyMap<string, SkillAccess>,
	after: ReadonlyMap<string, SkillAccess>,
): number {
	const paths = new Set([...before.keys(), ...after.keys()]);
	let changed = 0;
	for (const path of paths) {
		const left = before.get(path);
		const right = after.get(path);
		if (!left || !right || left.model !== right.model || left.user !== right.user) changed += 1;
	}
	return changed;
}

export function readPolicyConfig(configPath: string): ReadPolicyResult {
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (isV3Config(parsed)) {
			return {
				overrides: new Map(
					Object.entries(parsed.overrides).map(([path, access]) => [canonicalPath(path), cloneAccess(access)]),
				),
				migrated: false,
			};
		}
		if (isLegacyConfig(parsed)) {
			return {
				overrides: new Map(
					parsed.disabledPaths.map((path) => [canonicalPath(path), accessForState("disabled")]),
				),
				migrated: true,
			};
		}
		return {
			overrides: new Map(),
			migrated: false,
			error: `Invalid skill control config: ${configPath}`,
		};
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return { overrides: new Map(), migrated: false };
		}
		return {
			overrides: new Map(),
			migrated: false,
			error: `Could not read skill control config: ${configPath}`,
		};
	}
}

export function writePolicyConfig(configPath: string, overrides: ReadonlyMap<string, SkillAccess>): void {
	const sortedEntries = [...overrides]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([path, access]) => [path, cloneAccess(access)] as const);
	const config: SkillControlConfigV3 = {
		version: CONFIG_VERSION,
		overrides: Object.fromEntries(sortedEntries),
	};
	const temporaryPath = `${configPath}.${process.pid}.tmp`;
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, configPath);
}
