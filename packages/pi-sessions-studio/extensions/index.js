import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildStudioUrl,
  ensureStudioServer,
  getStudioStatus,
  stopStudioServer,
} from './runtime.js';

const SUBCOMMANDS = [
  { value: 'current', label: 'current', description: '打开当前会话（默认）' },
  { value: 'home', label: 'home', description: '打开 Studio 总览' },
  { value: 'status', label: 'status', description: '查看本地服务状态' },
  { value: 'stop', label: 'stop', description: '停止本地服务' },
];

function report(ctx, message, level = 'info') {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function parseSubcommand(args) {
  const input = String(args || '').trim();
  if (!input) return 'current';
  const [command, ...extra] = input.split(/\s+/);
  if (extra.length > 0 || !SUBCOMMANDS.some((item) => item.value === command)) {
    return null;
  }
  return command;
}

export function resolveSessionsDir(ctx, env = process.env, homeDir = os.homedir()) {
  if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR;

  const activeSessionDir = ctx.sessionManager.getSessionDir?.();
  if (activeSessionDir) {
    const usesDefaultDir = ctx.sessionManager.usesDefaultSessionDir?.();
    if (usesDefaultDir === true) return path.dirname(activeSessionDir);
    if (usesDefaultDir === false) return activeSessionDir;

    const name = path.basename(activeSessionDir);
    const parent = path.dirname(activeSessionDir);
    if (name.startsWith('--') && name.endsWith('--') && path.basename(parent) === 'sessions') {
      return parent;
    }
    return activeSessionDir;
  }

  const piConfigDir = env.PI_CODING_AGENT_DIR || path.join(homeDir, '.pi', 'agent');
  return path.join(piConfigDir, 'sessions');
}

export async function openStudioUrl(pi, url, platform = process.platform) {
  let command;
  let args;
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const result = await pi.exec(command, args, { timeout: 5_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr?.trim() || `打开浏览器失败，退出码 ${result.code}`);
  }
}

export function registerStudioExtension(pi, overrides = {}) {
  const dependencies = {
    ensureStudioServer,
    getStudioStatus,
    stopStudioServer,
    openStudioUrl,
    ...overrides,
  };

  pi.registerCommand('studio', {
    description: '在浏览器中复盘当前 Pi 会话',
    getArgumentCompletions(prefix) {
      const input = String(prefix || '').trimStart();
      if (input.includes(' ')) return null;
      const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(input));
      return matches.length > 0 ? matches : null;
    },
    async handler(args, ctx) {
      const subcommand = parseSubcommand(args);
      if (!subcommand) {
        report(ctx, '用法：/studio [current|home|status|stop]', 'warning');
        return;
      }

      const sessionsDir = resolveSessionsDir(ctx);
      try {
        if (subcommand === 'status') {
          const status = await dependencies.getStudioStatus({ sessionsDir });
          report(
            ctx,
            status.running
              ? `Pi Sessions Studio 正在运行：${status.baseUrl}（PID ${status.pid}）`
              : 'Pi Sessions Studio 当前未运行',
            'info'
          );
          return;
        }

        if (subcommand === 'stop') {
          const result = await dependencies.stopStudioServer({ sessionsDir });
          report(
            ctx,
            result.stopped
              ? `Pi Sessions Studio 已停止（PID ${result.pid}）`
              : 'Pi Sessions Studio 当前未运行',
            'info'
          );
          return;
        }

        report(ctx, '正在启动 Pi Sessions Studio…', 'info');
        const service = await dependencies.ensureStudioServer({ sessionsDir });
        const sessionFile = ctx.sessionManager.getSessionFile();
        const persisted = ctx.sessionManager.isPersisted()
          && Boolean(sessionFile)
          && existsSync(sessionFile);
        const url = buildStudioUrl(service.baseUrl, {
          home: subcommand === 'home',
          persisted,
          sessionId: persisted ? ctx.sessionManager.getSessionId() : undefined,
          leafId: persisted ? ctx.sessionManager.getLeafId() : undefined,
        });

        if (!persisted && subcommand === 'current') {
          report(ctx, '当前会话未持久化，已改为打开 Studio 总览', 'warning');
        }

        if (ctx.mode === 'tui') {
          try {
            await dependencies.openStudioUrl(pi, url);
            report(ctx, `Pi Sessions Studio：${url}`, 'info');
          } catch (error) {
            report(ctx, `浏览器未能自动打开，请访问：${url}（${error.message}）`, 'warning');
          }
        } else {
          report(ctx, url, 'info');
        }
      } catch (error) {
        report(ctx, `Pi Sessions Studio：${error?.message || String(error)}`, 'error');
      }
    },
  });
}

export default function studioExtension(pi) {
  registerStudioExtension(pi);
}
