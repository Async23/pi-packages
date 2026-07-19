import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "fast-mode-state";
const STATUS_ID = "fast-mode";
const CODEX_PROVIDER = "openai-codex";

type FastCommand = "on" | "off" | "status";

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

		const label = isCodexActive(ctx) ? "fast" : "fast:inactive";
		const color = isCodexActive(ctx) ? "accent" : "warning";
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg(color, label));
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
		getArgumentCompletions: (prefix) => {
			const commands: FastCommand[] = ["on", "off", "status"];
			const matches = commands.filter((command) => command.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches.map((command) => ({ value: command, label: command })) : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command !== "" && command !== "on" && command !== "off" && command !== "status") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "error");
				return;
			}

			if (command === "status") {
				ctx.ui.notify(statusMessage(ctx), "info");
				return;
			}

			setEnabled(command === "on" || (command === "" && !enabled), ctx);
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
