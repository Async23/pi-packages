import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const FONT_AWESOME_USER_ICON = "\uf007";
export const FALLBACK_USER_ICON = "\u24e4";
export const BLOCKED_ICON = "\u2298";

const NERD_FONT_PATTERN = /(?:nerd\s*font|font\s*awesome)/i;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export type FontProbe = (file: string, args: readonly string[]) => string | undefined;
export type FontEnvironment = Readonly<Record<string, string | undefined>>;

function defaultFontProbe(file: string, args: readonly string[]): string | undefined {
	try {
		return execFileSync(file, [...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 500,
			maxBuffer: 1024 * 1024,
		});
	} catch {
		return undefined;
	}
}

function explicitSupport(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return undefined;
}

export function detectNerdFontSupport(
	environment: FontEnvironment = process.env,
	probe: FontProbe = defaultFontProbe,
): boolean {
	const explicit = explicitSupport(environment.PI_SKILL_CONTROL_NERD_FONT);
	if (explicit !== undefined) return explicit;

	if (environment.GHOSTTY_BIN_DIR) {
		const effectiveConfig = probe(join(environment.GHOSTTY_BIN_DIR, "ghostty"), ["+show-config"]);
		if (effectiveConfig && NERD_FONT_PATTERN.test(effectiveConfig)) return true;
	}

	const fontFamilies = probe("fc-list", [":charset=f007", "family"]);
	return fontFamilies ? NERD_FONT_PATTERN.test(fontFamilies) : false;
}

let cachedUserOnlyIcon: string | undefined;

export function userOnlyIconForSupport(nerdFontSupported: boolean): string {
	return nerdFontSupported ? FONT_AWESOME_USER_ICON : FALLBACK_USER_ICON;
}

export function detectedUserOnlyIcon(): string {
	if (cachedUserOnlyIcon === undefined) {
		cachedUserOnlyIcon = userOnlyIconForSupport(detectNerdFontSupport());
	}
	return cachedUserOnlyIcon;
}
