import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpToolInventoryClient, type McpToolInventorySnapshotV1 } from "./inventory-protocol.ts";
import { ToolControlPanel, type ToolControlPanelResult } from "./panel.ts";
import { ToolSelectionController } from "./policy.ts";

export * from "./inventory-protocol.ts";
export * from "./panel.ts";
export * from "./policy.ts";

export default function toolControlExtension(pi: ExtensionAPI) {
	let runtimeReady = false;
	let currentContext: ExtensionContext | undefined;
	let controller: ToolSelectionController;

	const applyMcpPreferences = (snapshot: McpToolInventorySnapshotV1): void => {
		if (!runtimeReady) return;
		try {
			controller.applyMcpPreferences(snapshot);
		} catch (error) {
			currentContext?.ui.notify(
				error instanceof Error ? `Could not apply MCP Tool preferences: ${error.message}` : "Could not apply MCP Tool preferences",
				"error",
			);
		}
	};

	const inventory = new McpToolInventoryClient(pi.events, applyMcpPreferences);
	controller = new ToolSelectionController(pi, () => inventory.snapshot());

	const restoreBranch = (ctx: ExtensionContext): void => {
		currentContext = ctx;
		runtimeReady = true;
		controller.restore(ctx.sessionManager.getBranch());
		inventory.request();
	};

	pi.on("session_start", (_event, ctx) => restoreBranch(ctx));
	pi.on("session_tree", (_event, ctx) => restoreBranch(ctx));
	pi.on("session_shutdown", () => {
		runtimeReady = false;
		currentContext = undefined;
		inventory.dispose();
	});

	pi.registerCommand("tools", {
		description: "Control the Tools exposed to the LLM in this Session Branch",
		handler: async (args, ctx) => {
			if (args.trim() !== "") {
				ctx.ui.notify("Usage: /tools", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			const current = controller.currentSelection();
			await ctx.ui.custom<ToolControlPanelResult>(
				(tui, theme, keybindings, done) =>
					new ToolControlPanel({
						tui,
						theme,
						keybindings,
						items: current.items,
						activeToolNames: current.activeToolNames,
						inactiveToolNames: current.inactiveToolNames,
						onApply: (inactiveToolNames) => {
							controller.apply(inactiveToolNames);
							return controller.currentSelection();
						},
						onDone: done,
					}),
				{
					overlay: true,
					overlayOptions: {
						width: 120,
						minWidth: 36,
						maxHeight: "90%",
						anchor: "center",
						margin: 1,
					},
				},
			);
		},
	});
}
