import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStudioUrl,
  ensureStudioServer,
  getStudioStatus,
  stopStudioServer,
} from '../extensions/runtime.js';
import { registerStudioExtension, resolveSessionsDir } from '../extensions/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function checkManifest() {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.ok(manifest.keywords?.includes('pi-package'), 'package.json 缺少 pi-package keyword');
  assert.deepEqual(manifest.pi?.extensions, ['./extensions/index.js']);
  assert.ok(manifest.files?.includes('extensions/'), 'npm files 未包含 extensions/');
  assert.ok(manifest.files?.includes('shared/'), 'npm files 未包含 shared/');
  assert.ok(manifest.files?.includes('server/'), 'npm files 未包含 server/');
  assert.ok(manifest.files?.includes('web/dist/'), 'npm files 未包含 web/dist/');
  assert.ok(manifest.dependencies?.express, '根包缺少 Express 运行时依赖');
  assert.ok(manifest.dependencies?.compression, '根包缺少 compression 运行时依赖');
}

function checkUrlBuilder() {
  assert.equal(
    buildStudioUrl('http://127.0.0.1:5177/', {
      persisted: true,
      sessionId: 'session/id',
      leafId: 'leaf id',
    }),
    'http://127.0.0.1:5177/sessions/session%2Fid#entry-leaf%20id'
  );
  assert.equal(
    buildStudioUrl('http://127.0.0.1:5177', { persisted: false }),
    'http://127.0.0.1:5177/'
  );
  assert.equal(
    buildStudioUrl('http://127.0.0.1:5177', {
      home: true,
      persisted: true,
      sessionId: 'ignored',
    }),
    'http://127.0.0.1:5177/'
  );

  assert.equal(
    resolveSessionsDir(
      { sessionManager: { getSessionDir: () => undefined } },
      { PI_CODING_AGENT_SESSION_DIR: '/tmp/custom-sessions' },
      '/tmp/home'
    ),
    '/tmp/custom-sessions'
  );
  assert.equal(
    resolveSessionsDir(
      { sessionManager: { getSessionDir: () => undefined } },
      {},
      '/tmp/home'
    ),
    '/tmp/home/.pi/agent/sessions'
  );
  assert.equal(
    resolveSessionsDir({
      sessionManager: {
        getSessionDir: () => '/tmp/home/.pi/agent/sessions/--work-project--',
        usesDefaultSessionDir: () => true,
      },
    }, {}, '/tmp/home'),
    '/tmp/home/.pi/agent/sessions'
  );
  assert.equal(
    resolveSessionsDir({
      sessionManager: {
        getSessionDir: () => '/tmp/custom-project-sessions',
        usesDefaultSessionDir: () => false,
      },
    }, {}, '/tmp/home'),
    '/tmp/custom-project-sessions'
  );
}

async function checkExtensionCommand() {
  const commands = new Map();
  const notifications = [];
  const openedUrls = [];
  const lifecycleCalls = [];
  const pi = {
    registerCommand(name, options) {
      commands.set(name, options);
    },
    async exec() {
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  registerStudioExtension(pi, {
    async ensureStudioServer(options) {
      lifecycleCalls.push(['ensure', options.sessionsDir]);
      return { baseUrl: 'http://127.0.0.1:61234', pid: 4321, reused: false };
    },
    async getStudioStatus(options) {
      lifecycleCalls.push(['status', options.sessionsDir]);
      return { running: true, baseUrl: 'http://127.0.0.1:61234', pid: 4321 };
    },
    async stopStudioServer(options) {
      lifecycleCalls.push(['stop', options.sessionsDir]);
      return { stopped: true, pid: 4321 };
    },
    async openStudioUrl(_pi, url) {
      openedUrls.push(url);
    },
  });

  const command = commands.get('studio');
  assert.ok(command, '未注册 /studio 命令');
  assert.ok(command.getArgumentCompletions('st')?.some((item) => item.value === 'status'));

  const ctx = {
    mode: 'tui',
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getSessionDir: () => '/tmp/pi sessions',
      isPersisted: () => true,
      getSessionFile: () => path.join(projectRoot, 'scripts/check-pi-package.mjs'),
      getSessionId: () => 'session-123',
      getLeafId: () => 'leaf-456',
    },
  };

  await command.handler('', ctx);
  assert.deepEqual(lifecycleCalls[0], ['ensure', '/tmp/pi sessions']);
  assert.equal(
    openedUrls[0],
    'http://127.0.0.1:61234/sessions/session-123#entry-leaf-456'
  );
  assert.ok(notifications.some(({ message }) => message.includes('61234')));

  await command.handler('status', ctx);
  await command.handler('stop', ctx);
  assert.ok(lifecycleCalls.some(([action]) => action === 'status'));
  assert.ok(lifecycleCalls.some(([action]) => action === 'stop'));
}

async function checkServerLifecycle() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-package-'));
  const sessionsDir = path.join(fixtureRoot, 'sessions');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  await mkdir(sessionsDir, { recursive: true });

  const options = {
    sessionsDir,
    runtimeRoot,
    serverEntry: path.join(projectRoot, 'server/src/index.js'),
    startupTimeoutMs: 10_000,
    healthTimeoutMs: 1_000,
  };

  try {
    const [first, second] = await Promise.all([
      ensureStudioServer(options),
      ensureStudioServer(options),
    ]);
    assert.equal(first.pid, second.pid, '并发启动产生了多个 Studio 进程');
    assert.equal(first.baseUrl, second.baseUrl);

    const healthResponse = await fetch(`${first.baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.service, 'pi-sessions-studio');
    assert.equal(health.pid, first.pid);
    assert.equal(path.resolve(health.sessionsDir), path.resolve(sessionsDir));

    const status = await getStudioStatus(options);
    assert.equal(status.running, true);
    assert.equal(status.pid, first.pid);

    const stopped = await stopStudioServer(options);
    assert.equal(stopped.stopped, true);

    const finalStatus = await getStudioStatus(options);
    assert.equal(finalStatus.running, false);
  } finally {
    await stopStudioServer(options).catch(() => {});
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

await checkManifest();
checkUrlBuilder();
await checkExtensionCommand();
await checkServerLifecycle();

console.log(JSON.stringify({
  manifest: 'ok',
  urlBuilder: 'ok',
  extensionCommand: 'ok',
  serverLifecycle: 'ok',
}, null, 2));
