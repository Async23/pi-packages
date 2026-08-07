import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'pi-sessions-special-'));
const sessionId = '11111111-2222-4333-8444-555555555555';
const fixtureFile = path.join(
  fixtureRoot,
  `2026-07-24T00-00-00-000Z_${sessionId}.jsonl`
);
const entries = [
  {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: '2026-07-24T00:00:00.000Z',
    cwd: '/tmp/pi-branch-summary-fixture',
  },
  {
    type: 'message',
    id: 'user0001',
    parentId: null,
    timestamp: '2026-07-24T00:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '请比较两个实现方案' }],
      timestamp: 1753315201000,
    },
  },
  {
    type: 'message',
    id: 'old00001',
    parentId: 'user0001',
    timestamp: '2026-07-24T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '旧分支选择了方案 A。' }],
      api: 'fixture',
      provider: 'fixture',
      model: 'fixture-model',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { total: 0.001 },
      },
      stopReason: 'stop',
      timestamp: 1753315202000,
    },
  },
  {
    type: 'branch_summary',
    id: 'branch01',
    parentId: 'user0001',
    timestamp: '2026-07-24T00:00:03.000Z',
    fromId: 'old00001',
    summary: '## 分支结论\n\n替代分支探索了方案 A，并保留了关键实现经验。',
    details: {
      readFiles: ['/workspace/src/a.js', '/workspace/src/b.js'],
      modifiedFiles: ['/workspace/src/c.js'],
    },
    usage: {
      input: 1200,
      output: 300,
      cacheRead: 400,
      cacheWrite: 0,
      reasoning: 50,
      totalTokens: 1900,
      cost: { total: 0.01 },
    },
  },
  {
    type: 'message',
    id: 'user0002',
    parentId: 'branch01',
    timestamp: '2026-07-24T00:00:04.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '现在继续方案 B。' }],
      timestamp: 1753315204000,
    },
  },
];
const rawFixture = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
writeFileSync(fixtureFile, rawFixture, 'utf8');

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error('无法分配测试端口'));
      });
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(baseUrl, child, getLogs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`测试服务提前退出：${getLogs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动
    }
    await delay(100);
  }
  throw new Error(`等待测试服务超时：${getLogs()}`);
}

async function stopServer(child) {
  if (child.exitCode != null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: String(port),
    PI_SESSIONS_DIR: fixtureRoot,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLogs = '';
server.stdout.on('data', (chunk) => {
  serverLogs += chunk;
});
server.stderr.on('data', (chunk) => {
  serverLogs += chunk;
});

let browser;
try {
  await waitForServer(baseUrl, server, () => serverLogs);

  const listResponse = await fetch(`${baseUrl}/api/sessions?limit=1`);
  const list = await listResponse.json();
  const summary = list.items?.[0];
  if (
    !summary
    || summary.id !== sessionId
    || summary.counts.branchSummaries !== 1
    || summary.counts.leaves !== 2
  ) {
    throw new Error(`分支摘要计数异常：${JSON.stringify(summary?.counts)}`);
  }

  const rawResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/export.jsonl`);
  const contentType = rawResponse.headers.get('content-type') || '';
  const disposition = rawResponse.headers.get('content-disposition') || '';
  const downloaded = await rawResponse.text();
  if (!rawResponse.ok) throw new Error(`JSONL 下载失败：HTTP ${rawResponse.status}`);
  if (!contentType.includes('application/x-ndjson')) {
    throw new Error(`JSONL Content-Type 异常：${contentType}`);
  }
  if (!disposition.includes(`session-${sessionId}.jsonl`)) {
    throw new Error(`JSONL Content-Disposition 异常：${disposition}`);
  }
  if (downloaded !== rawFixture) throw new Error('下载的 JSONL 与原始文件不一致');

  const markdownResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/export.md`);
  const markdown = await markdownResponse.text();
  if (!markdown.includes('## ⑂ 分支摘要') || !markdown.includes('替代分支探索了方案 A')) {
    throw new Error('Markdown 导出没有包含分支摘要');
  }

  const searchResponse = await fetch(
    `${baseUrl}/api/search?q=${encodeURIComponent('替代分支探索')}&kind=branch_summary`
  );
  const searchResult = await searchResponse.json();
  if (searchResult.results?.[0]?.entryId !== 'branch01') {
    throw new Error(`分支摘要搜索异常：${JSON.stringify(searchResult.results)}`);
  }

  const require = createRequire(import.meta.url);
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const playwrightPath = require.resolve('playwright', {
    paths: [
      `${globalRoot}/@playwright/mcp/node_modules`,
      `${globalRoot}/playwright/node_modules`,
      globalRoot,
    ],
  });
  const { chromium } = require(playwrightPath);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`page: ${error.message}`));

  await page.goto(`${baseUrl}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
  const card = page.locator('.msg.branch-summary');
  await card.waitFor({ state: 'visible' });
  const cardText = await card.textContent();
  if (!cardText.includes('替代分支探索了方案 A')) {
    throw new Error('分支摘要正文没有渲染');
  }
  if (await card.locator('.branch-summary-content.open').count() !== 1) {
    throw new Error('分支摘要默认没有展开');
  }
  if (await card.locator('.branch-file-chip').count() !== 3) {
    throw new Error('分支摘要文件轨迹没有完整渲染');
  }
  if (await page.locator('a[href$="/export.jsonl"]').count() !== 1) {
    throw new Error('会话详情没有 JSONL 下载入口');
  }
  const branchBannerText = await page.locator('.branch-banner').textContent();
  if (!branchBannerText.includes('2 条分支路径')) {
    throw new Error('前端分支路径计数异常');
  }
  if (browserErrors.length) throw new Error(`浏览器报错：${browserErrors.join(' | ')}`);
  if (process.env.PI_SPECIAL_SCREENSHOT) {
    await page.screenshot({ path: process.env.PI_SPECIAL_SCREENSHOT, fullPage: false });
  }

  console.log(JSON.stringify({
    sessionId,
    branchSummaries: summary.counts.branchSummaries,
    rawBytes: Buffer.byteLength(downloaded),
    searchHits: searchResult.results.length,
    fileChips: 3,
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await stopServer(server);
  rmSync(fixtureRoot, { recursive: true, force: true });
}
