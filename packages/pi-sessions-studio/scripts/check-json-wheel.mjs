import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

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

const baseUrl = process.env.PI_SESSIONS_URL || 'http://127.0.0.1:5177';
const sessionsResponse = await fetch(`${baseUrl}/api/sessions?limit=1`);
if (!sessionsResponse.ok) {
  throw new Error(`无法读取会话列表：HTTP ${sessionsResponse.status}`);
}
const sessions = await sessionsResponse.json();
const sessionId = process.env.PI_SESSION_ID || sessions.items?.[0]?.id;
if (!sessionId) throw new Error('没有可用于滚轮回归检查的会话');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${baseUrl}/sessions/${sessionId}`, { waitUntil: 'networkidle' });

  const firstInspector = page.locator('.json-inspector').first();
  await firstInspector.locator('.json-summary-toggle').click();
  const tree = firstInspector.locator('.json-tree');
  await tree.waitFor({ state: 'visible' });

  await tree.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(50);

  const before = await page.evaluate(() => {
    const outer = document.querySelector('.content');
    const treeElement = document.querySelector('.json-inspector.open .json-tree');
    const maxOuterScroll = outer.scrollHeight - outer.clientHeight;
    if (outer.scrollTop > maxOuterScroll - 400) {
      outer.scrollTop = Math.max(0, maxOuterScroll - 600);
    }
    return {
      outerTop: outer.scrollTop,
      outerMax: maxOuterScroll,
      innerTop: treeElement.scrollTop,
      innerScrollable: treeElement.scrollHeight > treeElement.clientHeight + 1,
    };
  });

  if (before.innerScrollable) {
    throw new Error('回归前置条件失败：选中的 JSON 树存在内部滚动条');
  }
  if (before.outerTop >= before.outerMax) {
    throw new Error('回归前置条件失败：外层页面已经位于底部');
  }

  const box = await tree.boundingBox();
  if (!box) throw new Error('无法获取 JSON 树位置');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 280);
  await page.waitForTimeout(180);

  const after = await page.evaluate(() => {
    const outer = document.querySelector('.content');
    const treeElement = document.querySelector('.json-inspector.open .json-tree');
    return {
      outerTop: outer.scrollTop,
      innerTop: treeElement.scrollTop,
    };
  });

  const result = {
    sessionId,
    before,
    after,
    outerDelta: after.outerTop - before.outerTop,
  };
  console.log(JSON.stringify(result, null, 2));

  if (result.outerDelta <= 0) {
    throw new Error('失败：JSON 无内部滚动条时，滚轮没有推动外层页面');
  }
} finally {
  await browser.close();
}
