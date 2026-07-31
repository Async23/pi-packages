/**
 * Report Pi's foreground activity to aipane's tmux-window-wrap helper.
 *
 * Pi owns the lifecycle signal; tmux-window-wrap owns the pane-local marker and
 * status-line rendering. Outside tmux, or when the helper is unavailable, the
 * extension is a silent no-op.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

export type ActivityState = "busy" | "idle";
export type Environment = Readonly<Record<string, string | undefined>>;
export type Sleep = (milliseconds: number) => Promise<void>;

const ACTIVITY_TIMEOUT_MS = 5_000;
const TEST_DURATION_MS = 1_200;

export function defaultWindowWrapBinary(): string {
  return join(homedir(), ".local", "bin", "tmux-window-wrap");
}

export function windowWrapBinary(environment: Environment): string {
  return (
    environment.PI_TMUX_WINDOW_WRAP_BIN?.trim() ||
    defaultWindowWrapBinary()
  );
}

export async function reportActivity(
  pi: ExtensionAPI,
  state: ActivityState,
  environment: Environment = process.env,
): Promise<boolean> {
  const paneId = environment.TMUX_PANE?.trim();
  if (!paneId) return false;

  try {
    const result = await pi.exec(
      windowWrapBinary(environment),
      ["activity", state, "--pane", paneId],
      { timeout: ACTIVITY_TIMEOUT_MS },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function registerTmuxWindowWrap(
  pi: ExtensionAPI,
  environment: Environment = process.env,
  sleep: Sleep = defaultSleep,
): void {
  const report = (state: ActivityState) =>
    reportActivity(pi, state, environment);

  pi.on("session_start", async () => {
    await report("idle");
  });

  pi.on("agent_start", async () => {
    await report("busy");
  });

  // agent_settled fires after retries, compaction, and queued follow-ups. Using
  // agent_end here would briefly mark Pi idle between related foreground runs.
  pi.on("agent_settled", async () => {
    await report("idle");
  });

  pi.on("session_shutdown", async () => {
    await report("idle");
  });

  pi.registerCommand("tmux-window-wrap-test", {
    description: "Pulse the current tmux window activity indicator",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (args.trim() !== "") {
        ctx.ui.notify("Usage: /tmux-window-wrap-test", "error");
        return;
      }
      if (!environment.TMUX_PANE?.trim()) {
        ctx.ui.notify("Not running inside tmux; no activity marker was sent.", "warning");
        return;
      }
      if (!(await report("busy"))) {
        ctx.ui.notify(
          "Could not set tmux activity; check that tmux-window-wrap is installed.",
          "error",
        );
        return;
      }

      try {
        await sleep(TEST_DURATION_MS);
      } finally {
        await report("idle");
      }
      ctx.ui.notify("tmux window activity indicator tested.", "info");
    },
  });
}

export default function piTmuxWindowWrapExtension(pi: ExtensionAPI): void {
  registerTmuxWindowWrap(pi);
}
