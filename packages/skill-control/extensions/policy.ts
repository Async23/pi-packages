import type { Skill } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";

export const CONFIG_VERSION = 5;
export const CONFIG_FILE_NAME = "skill-control.json";

export type SkillAvailabilityState = "model-and-command" | "command-only" | "blocked";

export interface SkillAvailability {
	modelVisible: boolean;
	commandAvailable: boolean;
}

export type BlockedSkillPaths = Set<string>;

interface SkillControlConfigV5 {
	version: typeof CONFIG_VERSION;
	blockedPaths: string[];
}

interface LegacyDisabledPathsConfig {
	version: 1 | 2 | 4;
	disabledPaths: string[];
}

interface LegacyInvocationOverride {
	model: boolean;
	user: boolean;
}

interface LegacySkillControlConfigV3 {
	version: 3;
	overrides: Record<string, LegacyInvocationOverride>;
}

export interface ReadPolicyResult {
	blockedPaths: BlockedSkillPaths;
	migrated: boolean;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyInvocationOverride(value: unknown): value is LegacyInvocationOverride {
	return isRecord(value) && typeof value.model === "boolean" && typeof value.user === "boolean";
}

function isV5Config(value: unknown): value is SkillControlConfigV5 {
	return (
		isRecord(value) &&
		value.version === CONFIG_VERSION &&
		Array.isArray(value.blockedPaths) &&
		value.blockedPaths.every((path) => typeof path === "string")
	);
}

function isLegacyDisabledPathsConfig(value: unknown): value is LegacyDisabledPathsConfig {
	return (
		isRecord(value) &&
		(value.version === 1 || value.version === 2 || value.version === 4) &&
		Array.isArray(value.disabledPaths) &&
		value.disabledPaths.every((path) => typeof path === "string")
	);
}

function isLegacyV3Config(value: unknown): value is LegacySkillControlConfigV3 {
	if (!isRecord(value) || value.version !== 3 || !isRecord(value.overrides)) return false;
	return Object.values(value.overrides).every(isLegacyInvocationOverride);
}

export function canonicalPath(filePath: string, cwd = process.cwd()): string {
	const absolutePath = normalize(resolve(cwd, filePath));
	try {
		return realpathSync.native(absolutePath);
	} catch {
		return absolutePath;
	}
}

export function nativeSkillAvailability(skill: Pick<Skill, "disableModelInvocation">): SkillAvailability {
	return { modelVisible: !skill.disableModelInvocation, commandAvailable: true };
}

export function effectiveSkillAvailability(
	path: string,
	nativeAvailability: SkillAvailability,
	blockedPaths: ReadonlySet<string>,
): SkillAvailability {
	if (blockedPaths.has(path)) return { modelVisible: false, commandAvailable: false };
	return {
		modelVisible: nativeAvailability.modelVisible,
		commandAvailable: nativeAvailability.commandAvailable,
	};
}

export function skillAvailabilityState(availability: SkillAvailability): SkillAvailabilityState {
	if (availability.modelVisible && availability.commandAvailable) return "model-and-command";
	if (availability.commandAvailable) return "command-only";
	return "blocked";
}

export function cloneBlockedPaths(blockedPaths: ReadonlySet<string>): BlockedSkillPaths {
	return new Set(blockedPaths);
}

export function replaceBlockedPaths(target: BlockedSkillPaths, source: ReadonlySet<string>): void {
	target.clear();
	for (const path of source) target.add(path);
}

export function blockedPathsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const path of left) {
		if (!right.has(path)) return false;
	}
	return true;
}

export function changedBlockedPathCount(before: ReadonlySet<string>, after: ReadonlySet<string>): number {
	const paths = new Set([...before, ...after]);
	let changed = 0;
	for (const path of paths) {
		if (before.has(path) !== after.has(path)) changed += 1;
	}
	return changed;
}

export function readPolicyConfig(configPath: string): ReadPolicyResult {
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (isV5Config(parsed)) {
			return {
				blockedPaths: new Set(parsed.blockedPaths.map((path) => canonicalPath(path))),
				migrated: false,
			};
		}
		if (isLegacyDisabledPathsConfig(parsed)) {
			return {
				blockedPaths: new Set(parsed.disabledPaths.map((path) => canonicalPath(path))),
				migrated: true,
			};
		}
		if (isLegacyV3Config(parsed)) {
			// V3 could independently remove model visibility or direct-command
			// availability. V5 only leaves the Skill Unblocked or makes it Blocked, so
			// conservatively migrate every policy that was not fully open to Blocked.
			return {
				blockedPaths: new Set(
					Object.entries(parsed.overrides)
						.filter(([, override]) => !override.model || !override.user)
						.map(([path]) => canonicalPath(path)),
				),
				migrated: true,
			};
		}
		return {
			blockedPaths: new Set(),
			migrated: false,
			error: `Invalid skill control config: ${configPath}`,
		};
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return { blockedPaths: new Set(), migrated: false };
		}
		return {
			blockedPaths: new Set(),
			migrated: false,
			error: `Could not read skill control config: ${configPath}`,
		};
	}
}

export function writePolicyConfig(configPath: string, blockedPaths: ReadonlySet<string>): void {
	const config: SkillControlConfigV5 = {
		version: CONFIG_VERSION,
		blockedPaths: [...blockedPaths].sort((left, right) => left.localeCompare(right)),
	};
	const temporaryPath = `${configPath}.${process.pid}.tmp`;
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, configPath);
}
