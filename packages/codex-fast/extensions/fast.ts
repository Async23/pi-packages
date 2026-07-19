import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "fast-mode";
const CODEX_PROVIDER = "openai-codex";
const CONFIG_PATH = join(getAgentDir(), "codex-fast.json");

interface FastModeState {
	enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFastModeState(value: unknown): value is FastModeState {
	return isRecord(value) && typeof value.enabled === "boolean";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function loadGlobalState(): Promise<boolean> {
	try {
		const state: unknown = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
		if (!isFastModeState(state)) throw new Error("expected an object with a boolean 'enabled' field");
		return state.enabled;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

async function saveGlobalState(enabled: boolean): Promise<void> {
	const tempPath = `${CONFIG_PATH}.${process.pid}.tmp`;
	await mkdir(getAgentDir(), { recursive: true });
	try {
		await writeFile(tempPath, `${JSON.stringify({ enabled }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, CONFIG_PATH);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

export default function fastModeExtension(pi: ExtensionAPI) {
	let enabled = false;

	function isCodexActive(ctx: ExtensionContext): boolean {
		return ctx.model?.provider === CODEX_PROVIDER;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}

		const text = isCodexActive(ctx)
			? ctx.ui.theme.fg("accent", "fast")
			: ctx.ui.theme.fg("dim", ctx.ui.theme.strikethrough("fast"));
		ctx.ui.setStatus(STATUS_ID, text);
	}

	function statusMessage(ctx: ExtensionContext): string {
		if (!enabled) return "Fast mode is off.";
		if (isCodexActive(ctx)) return "Fast mode is on for OpenAI Codex (service_tier: priority).";
		return "Fast mode is on but inactive; select an openai-codex model to use it.";
	}

	async function setEnabled(nextEnabled: boolean, ctx: ExtensionContext): Promise<void> {
		try {
			await saveGlobalState(nextEnabled);
		} catch (error) {
			ctx.ui.notify(`Failed to save Fast mode state: ${errorMessage(error)}`, "error");
			return;
		}

		enabled = nextEnabled;
		updateStatus(ctx);
		ctx.ui.notify(statusMessage(ctx), enabled && !isCodexActive(ctx) ? "warning" : "info");
	}

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast mode (priority service tier)",
		handler: async (args, ctx) => {
			if (args.trim() !== "") {
				ctx.ui.notify("Usage: /fast", "error");
				return;
			}
			await setEnabled(!enabled, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			enabled = await loadGlobalState();
		} catch (error) {
			enabled = false;
			ctx.ui.notify(`Failed to load Fast mode state; defaulting to off: ${errorMessage(error)}`, "warning");
		}
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !isCodexActive(ctx) || !isRecord(event.payload)) return;
		return { ...event.payload, service_tier: "priority" };
	});
}
