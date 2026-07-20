import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const testRoot = mkdtempSync(join(tmpdir(), "pi-notify-test-"));
const testApp = join(testRoot, "Pi Notifier.app");
const testNotifier = join(testApp, "Contents", "MacOS", "terminal-notifier");
mkdirSync(join(testApp, "Contents", "MacOS"), { recursive: true });
writeFileSync(testNotifier, "#!/bin/sh\nexit 0\n");
chmodSync(testNotifier, 0o755);
after(() => rmSync(testRoot, { recursive: true, force: true }));

process.env.PI_NOTIFY_APP = testApp;
process.env.PI_NOTIFY_DISABLE_LOG = "1";
process.env.TMUX_PANE = "%931";

const extension = await import("../extensions/index.ts");

const {
  buildFocusCommand,
  cleanPaneTitle,
  default: registerPiNotify,
  extractMessageText,
  notificationSubtitle,
  notificationSummary,
  parseTmuxTarget,
  shellQuote,
  shortDisplayText,
} = extension;

test("formats prompt subtitles for macOS notifications", () => {
  assert.equal(
    notificationSubtitle("[Image #1] 第一个选项是什么"),
    "第一个选项是什么",
  );
  assert.equal(notificationSubtitle("[Image #2]"), "图片请求");
  assert.equal(shortDisplayText("测".repeat(25), 48), "测".repeat(22) + "...");
});

test("summarizes assistant output without generic Markdown headings", () => {
  assert.equal(
    notificationSummary("## 结论\n\nPi 通知扩展已经安装。\n\n其他内容"),
    "Pi 通知扩展已经安装。",
  );
  assert.equal(
    notificationSummary("[配置文件](file:///tmp/config.ts) 已更新。"),
    "配置文件 已更新。",
  );
});

test("extracts only visible assistant text", () => {
  assert.equal(
    extractMessageText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "第一行" },
        { type: "toolCall", name: "read" },
        { type: "text", text: "第二行" },
      ],
    }),
    "第一行\n第二行",
  );
});

test("parses tmux coordinates and builds a safely quoted focus command", () => {
  const target = parseTmuxTarget(
    "$0\tcurrent work\t@343\t21\t%931\t1\tπ - 通知测试\n",
  );
  assert.deepEqual(target, {
    coordinate: "0:21:1",
    sessionName: "current work",
    windowId: "@343",
    windowIndex: "21",
    paneId: "%931",
    paneIndex: "1",
    paneTitle: "π - 通知测试",
  });
  assert.equal(cleanPaneTitle(target.paneTitle), "通知测试");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  const command = buildFocusCommand(target);
  assert.match(command, /focus-tmux\.sh/);
  assert.match(command, /'current work'/);
  assert.match(command, /'%931'/);
});

function createLifecycleHarness() {
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getSessionName() {
      return "通知测试";
    },
    async exec(command, args) {
      calls.push({ command, args });
      if (String(command).endsWith("tmux")) {
        return {
          code: 0,
          stdout: "$0\tcurrent\t@343\t21\t%931\t1\tπ - alfheim\n",
          stderr: "",
          killed: false,
        };
      }
      if (command === "git") {
        return {
          code: 0,
          stdout: "/Users/alfheim\n",
          stderr: "",
          killed: false,
        };
      }
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };

  registerPiNotify(pi);
  const ctx = {
    mode: "tui",
    cwd: "/Users/alfheim",
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-123",
      getLeafId: () => "leaf-456",
      getBranch: () => [],
    },
  };
  return { calls, commands, ctx, handlers };
}

function notifierCall(calls) {
  return calls.find((call) =>
    String(call.command).includes("Pi Notifier.app/Contents/MacOS/terminal-notifier"),
  );
}

test("registers lifecycle handlers and sends after agent_settled", async () => {
  const { calls, commands, ctx, handlers } = createLifecycleHarness();
  assert.deepEqual(
    [...handlers.keys()],
    ["input", "before_agent_start", "message_end", "agent_settled"],
  );
  assert.ok(commands.has("pi-notify-setup"));
  assert.ok(commands.has("pi-notify-test"));

  handlers.get("input")({ text: "帮我实现通知", source: "interactive" });
  handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  handlers.get("message_end")({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "已经实现并通过测试。" }],
    },
  });

  await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);

  const call = notifierCall(calls);
  assert.ok(call, "custom Pi notifier should be selected");
  assert.deepEqual(call.args.slice(0, 6), [
    "-title",
    "0:21:1 · 通知测试",
    "-subtitle",
    "帮我实现通知",
    "-message",
    "已经实现并通过测试。",
  ]);
  assert.ok(call.args.includes("-execute"));
});

test("reports terminal cyber_policy errors instead of completion", async () => {
  const { calls, ctx, handlers } = createLifecycleHarness();
  handlers.get("input")({ text: "继续当前任务", source: "interactive" });
  handlers.get("before_agent_start")({ prompt: "继续当前任务" });
  handlers.get("message_end")({
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "internal" }],
      stopReason: "error",
      errorMessage:
        "Codex error: This content was flagged for possible cybersecurity risk. To get authorized for security work, join the Trusted Access for Cyber program.",
    },
  });

  await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);

  const call = notifierCall(calls);
  assert.ok(call, "custom Pi notifier should be selected");
  assert.deepEqual(call.args.slice(2, 6), [
    "-subtitle",
    "继续当前任务",
    "-message",
    "任务被 cyber_policy 拦截；请返回 Pi 查看详情。",
  ]);
});

test("reports an aborted task instead of completion", async () => {
  const { calls, ctx, handlers } = createLifecycleHarness();
  handlers.get("input")({ text: "停止当前任务", source: "interactive" });
  handlers.get("before_agent_start")({ prompt: "停止当前任务" });
  handlers.get("message_end")({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "尚未完成的部分结果" }],
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    },
  });

  await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);

  const call = notifierCall(calls);
  assert.ok(call, "custom Pi notifier should be selected");
  assert.deepEqual(call.args.slice(2, 6), [
    "-subtitle",
    "停止当前任务",
    "-message",
    "任务已取消。",
  ]);
});

test("clears a transient error when an automatic retry succeeds", async () => {
  const { calls, ctx, handlers } = createLifecycleHarness();
  handlers.get("input")({ text: "继续当前任务", source: "interactive" });
  handlers.get("before_agent_start")({ prompt: "继续当前任务" });
  handlers.get("message_end")({
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "temporary provider error",
    },
  });
  handlers.get("message_end")({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "自动重试后任务完成。" }],
      stopReason: "stop",
    },
  });

  await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);

  const call = notifierCall(calls);
  assert.ok(call, "custom Pi notifier should be selected");
  assert.deepEqual(call.args.slice(4, 6), [
    "-message",
    "自动重试后任务完成。",
  ]);
});
