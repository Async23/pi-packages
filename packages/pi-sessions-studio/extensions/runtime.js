import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STUDIO_SERVICE_ID,
  normalizeSessionsDir,
  readRuntimeState,
  runtimeStateBaseUrl,
} from '../shared/runtime-state.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 750;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_SERVER_ENTRY = fileURLToPath(new URL('../server/src/index.js', import.meta.url));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function defaultRuntimeRoot() {
  const piConfigDir = process.env.PI_CODING_AGENT_DIR
    || path.join(os.homedir(), '.pi', 'agent');
  return path.join(piConfigDir, 'pi-sessions-studio');
}

export function getRuntimePaths(sessionsDir, runtimeRoot = defaultRuntimeRoot()) {
  const normalizedDir = normalizeSessionsDir(sessionsDir);
  const key = createHash('sha256').update(normalizedDir).digest('hex').slice(0, 16);
  return {
    runtimeRoot,
    stateFile: path.join(runtimeRoot, `${key}.json`),
    lockFile: path.join(runtimeRoot, `${key}.lock`),
    logFile: path.join(runtimeRoot, `${key}.log`),
  };
}

async function fetchHealth(baseUrl, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function healthMatches(health, state, sessionsDir) {
  return Boolean(
    health
    && health.service === STUDIO_SERVICE_ID
    && health.pid === state.pid
    && normalizeSessionsDir(health.sessionsDir) === normalizeSessionsDir(sessionsDir)
  );
}

async function inspectRuntime({
  sessionsDir,
  runtimeRoot,
  fetchImpl,
  healthTimeoutMs,
  removeStale = true,
}) {
  const paths = getRuntimePaths(sessionsDir, runtimeRoot);
  const state = await readRuntimeState(paths.stateFile);
  if (!state) {
    if (removeStale) await fs.rm(paths.stateFile, { force: true });
    return { running: false, ...paths };
  }

  const baseUrl = runtimeStateBaseUrl(state);
  const health = await fetchHealth(baseUrl, fetchImpl, healthTimeoutMs);
  if (healthMatches(health, state, sessionsDir)) {
    return {
      running: true,
      baseUrl,
      pid: state.pid,
      state,
      ...paths,
    };
  }

  if (removeStale) await fs.rm(paths.stateFile, { force: true });
  return { running: false, stalePid: state.pid, ...paths };
}

async function acquireRuntimeLock(lockFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const staleAfterMs = Math.max(timeoutMs * 2, 30_000);

  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
      await handle.close();
      return async () => {
        await fs.rm(lockFile, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      try {
        const [rawLock, stat] = await Promise.all([
          fs.readFile(lockFile, 'utf8'),
          fs.stat(lockFile),
        ]);
        const ownerPid = JSON.parse(rawLock).pid;
        if (!isProcessAlive(ownerPid) || Date.now() - stat.mtimeMs > staleAfterMs) {
          await fs.rm(lockFile, { force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') continue;
      }

      await delay(75);
    }
  }

  throw new Error('等待 Pi Sessions Studio 启动锁超时');
}

async function spawnStudioProcess({
  sessionsDir,
  paths,
  serverEntry,
  spawnImpl,
  env,
}) {
  await fs.mkdir(paths.runtimeRoot, { recursive: true });
  const logHandle = await fs.open(paths.logFile, 'a', 0o600);
  let child;
  try {
    child = spawnImpl(process.execPath, [serverEntry], {
      cwd: path.dirname(serverEntry),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      env: {
        ...env,
        PI_SESSIONS_DIR: normalizeSessionsDir(sessionsDir),
        PI_STUDIO_HOST: '127.0.0.1',
        PI_STUDIO_STATE_FILE: paths.stateFile,
        PORT: '0',
      },
    });
  } finally {
    await logHandle.close();
  }

  child.on('error', () => {});
  if (!child.pid) throw new Error(`无法启动 Pi Sessions Studio；日志：${paths.logFile}`);
  child.unref();
  return child.pid;
}

export async function getStudioStatus({
  sessionsDir,
  runtimeRoot = defaultRuntimeRoot(),
  fetchImpl = fetch,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
}) {
  if (!sessionsDir) throw new Error('缺少 Pi Session 数据目录');
  return inspectRuntime({
    sessionsDir,
    runtimeRoot,
    fetchImpl,
    healthTimeoutMs,
  });
}

export async function ensureStudioServer({
  sessionsDir,
  runtimeRoot = defaultRuntimeRoot(),
  serverEntry = DEFAULT_SERVER_ENTRY,
  spawnImpl = spawn,
  fetchImpl = fetch,
  env = process.env,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
}) {
  if (!sessionsDir) throw new Error('缺少 Pi Session 数据目录');

  await fs.mkdir(runtimeRoot, { recursive: true });
  const inspectOptions = { sessionsDir, runtimeRoot, fetchImpl, healthTimeoutMs };
  const existing = await inspectRuntime(inspectOptions);
  if (existing.running) return { ...existing, reused: true };

  const paths = getRuntimePaths(sessionsDir, runtimeRoot);
  const releaseLock = await acquireRuntimeLock(paths.lockFile, startupTimeoutMs + 2_000);
  let spawnedPid;
  try {
    const afterLock = await inspectRuntime(inspectOptions);
    if (afterLock.running) return { ...afterLock, reused: true };

    await fs.rm(paths.stateFile, { force: true });
    spawnedPid = await spawnStudioProcess({
      sessionsDir,
      paths,
      serverEntry,
      spawnImpl,
      env,
    });

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      const current = await inspectRuntime({ ...inspectOptions, removeStale: false });
      if (current.running) return { ...current, reused: false };
      if (!isProcessAlive(spawnedPid)) {
        throw new Error(`Pi Sessions Studio 启动失败；日志：${paths.logFile}`);
      }
      await delay(100);
    }

    throw new Error(`Pi Sessions Studio 启动超时；日志：${paths.logFile}`);
  } catch (error) {
    if (spawnedPid && isProcessAlive(spawnedPid)) {
      try {
        process.kill(spawnedPid, 'SIGTERM');
      } catch {
        // 启动失败时尽力清理子进程
      }
    }
    await fs.rm(paths.stateFile, { force: true });
    throw error;
  } finally {
    await releaseLock();
  }
}

export async function stopStudioServer({
  sessionsDir,
  runtimeRoot = defaultRuntimeRoot(),
  fetchImpl = fetch,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
}) {
  if (!sessionsDir) throw new Error('缺少 Pi Session 数据目录');

  await fs.mkdir(runtimeRoot, { recursive: true });
  const paths = getRuntimePaths(sessionsDir, runtimeRoot);
  const releaseLock = await acquireRuntimeLock(paths.lockFile, stopTimeoutMs + 2_000);
  try {
    const status = await inspectRuntime({
      sessionsDir,
      runtimeRoot,
      fetchImpl,
      healthTimeoutMs,
    });
    if (!status.running) return { stopped: false };

    try {
      process.kill(status.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }

    const deadline = Date.now() + stopTimeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(status.pid)) {
        await fs.rm(paths.stateFile, { force: true });
        return { stopped: true, pid: status.pid };
      }
      await delay(100);
    }

    throw new Error(`Pi Sessions Studio 未能在 ${stopTimeoutMs}ms 内停止`);
  } finally {
    await releaseLock();
  }
}

export function buildStudioUrl(baseUrl, {
  home = false,
  persisted = false,
  sessionId,
  leafId,
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  if (home || !persisted || !sessionId) return `${root}/`;

  const sessionUrl = `${root}/sessions/${encodeURIComponent(sessionId)}`;
  return leafId
    ? `${sessionUrl}#entry-${encodeURIComponent(leafId)}`
    : sessionUrl;
}
