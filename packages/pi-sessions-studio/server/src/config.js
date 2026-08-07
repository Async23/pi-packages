import os from 'node:os';
import path from 'node:path';

export const SESSIONS_DIR =
  process.env.PI_SESSIONS_DIR || path.join(os.homedir(), '.pi', 'agent', 'sessions');

const configuredPort = Number(process.env.PORT ?? 5177);
export const PORT = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535
  ? configuredPort
  : 5177;

export const HOST = process.env.PI_STUDIO_HOST || '127.0.0.1';
export const RUNTIME_STATE_FILE = process.env.PI_STUDIO_STATE_FILE || null;
