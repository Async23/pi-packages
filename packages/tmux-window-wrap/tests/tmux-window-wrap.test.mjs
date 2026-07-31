import assert from "node:assert/strict";
import test from "node:test";

const {
  default: registerExtension,
  defaultWindowWrapBinary,
  registerTmuxWindowWrap,
  reportActivity,
  windowWrapBinary,
} = await import("../extensions/index.ts");

function createHarness({
  environment = {
    HOME: "/Users/tester",
    TMUX_PANE: "%42",
    PI_TMUX_WINDOW_WRAP_BIN: "/opt/test/tmux-window-wrap",
  },
  execResult = { code: 0, stdout: "", stderr: "", killed: false },
  execError,
} = {}) {
  const calls = [];
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const sleeps = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    async exec(command, args, options) {
      calls.push({ command, args, options });
      if (execError) throw execError;
      return execResult;
    },
  };
  const ctx = {
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
  const sleep = async (milliseconds) => {
    sleeps.push(milliseconds);
  };

  registerTmuxWindowWrap(pi, environment, sleep);
  return {
    calls,
    commands,
    ctx,
    environment,
    handlers,
    notifications,
    pi,
    sleeps,
  };
}

test("default export registers as a Pi extension", () => {
  const handlers = new Map();
  const commands = new Map();
  registerExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });

  assert.deepEqual(
    [...handlers.keys()],
    ["session_start", "agent_start", "agent_settled", "session_shutdown"],
  );
  assert.ok(commands.has("tmux-window-wrap-test"));
});

test("maps the complete Pi lifecycle to pane activity", async () => {
  const { calls, handlers } = createHarness();

  await handlers.get("session_start")({});
  await handlers.get("agent_start")({});
  await handlers.get("agent_settled")({});
  await handlers.get("session_shutdown")({});

  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ["activity", "idle", "--pane", "%42"],
      ["activity", "busy", "--pane", "%42"],
      ["activity", "idle", "--pane", "%42"],
      ["activity", "idle", "--pane", "%42"],
    ],
  );
  assert.ok(calls.every(({ command }) => command === "/opt/test/tmux-window-wrap"));
  assert.ok(calls.every(({ options }) => options.timeout === 5_000));
});

test("stays silent outside tmux and when the helper fails", async () => {
  const outside = createHarness({ environment: {} });
  await outside.handlers.get("agent_start")({});
  assert.equal(outside.calls.length, 0);

  const failed = createHarness({ execError: new Error("missing helper") });
  assert.equal(
    await reportActivity(failed.pi, "busy", failed.environment),
    false,
  );
});

test("uses the default helper path unless explicitly overridden", () => {
  assert.match(defaultWindowWrapBinary(), /\/\.local\/bin\/tmux-window-wrap$/u);
  assert.equal(
    windowWrapBinary({ PI_TMUX_WINDOW_WRAP_BIN: " /custom/wrap " }),
    "/custom/wrap",
  );
});

test("manual test command pulses busy then idle", async () => {
  const {
    calls,
    commands,
    ctx,
    notifications,
    sleeps,
  } = createHarness();

  await commands.get("tmux-window-wrap-test").handler("", ctx);

  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ["activity", "busy", "--pane", "%42"],
      ["activity", "idle", "--pane", "%42"],
    ],
  );
  assert.deepEqual(sleeps, [1_200]);
  assert.deepEqual(notifications, [
    {
      message: "tmux window activity indicator tested.",
      level: "info",
    },
  ]);
});
