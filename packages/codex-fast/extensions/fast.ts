import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "fast-mode-state";
const STATUS_ID = "fast-mode";
const CODEX_PROVIDER = "openai-codex";

interface FastModeState {
	enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFastModeState(value: unknown): value is FastModeState {
	return isRecord(value) && typeof value.enabled === "boolean";
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

	function setEnabled(nextEnabled: boolean, ctx: ExtensionContext): void {
		enabled = nextEnabled;
		pi.appendEntry(STATE_ENTRY_TYPE, { enabled });
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
			setEnabled(!enabled, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE && isFastModeState(entry.data)) {
				enabled = entry.data.enabled;
			}
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
