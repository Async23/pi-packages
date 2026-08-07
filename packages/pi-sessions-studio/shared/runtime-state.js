import fs from 'node:fs/promises';
import path from 'node:path';

export const STUDIO_SERVICE_ID = 'pi-sessions-studio';

export function normalizeSessionsDir(sessionsDir) {
  return path.resolve(String(sessionsDir));
}

export function runtimeStateBaseUrl(state) {
  const host = state.host.includes(':') ? `[${state.host}]` : state.host;
  return `http://${host}:${state.port}`;
}

function isRuntimeState(value) {
  return Boolean(
    value
    && value.service === STUDIO_SERVICE_ID
    && Number.isInteger(value.pid)
    && value.pid > 0
    && typeof value.host === 'string'
    && value.host.length > 0
    && Number.isInteger(value.port)
    && value.port > 0
    && value.port <= 65_535
    && typeof value.sessionsDir === 'string'
    && value.sessionsDir.length > 0
  );
}

export async function readRuntimeState(stateFile) {
  try {
    const value = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    return isRuntimeState(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeRuntimeState(stateFile, state) {
  if (!isRuntimeState(state)) throw new Error('无效的 Pi Sessions Studio 运行状态');

  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(tempFile, stateFile);
}

export async function removeOwnedRuntimeState(stateFile, ownerPid) {
  const state = await readRuntimeState(stateFile);
  if (!state || state.pid !== ownerPid) return false;
  await fs.rm(stateFile, { force: true });
  return true;
}
