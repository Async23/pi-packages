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
if (!sessionId) throw new Error('没有可用于布局检查的会话');

const routes = [
  '/',
  '/sessions',
  '/search',
  '/insights',
  '/schema',
  `/sessions/${sessionId}`,
];
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 430, height: 900 },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = [];
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));

    for (const route of routes) {
      errors.length = 0;
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(100);
      const layout = await page.evaluate(() => {
        const selectors = ['html', 'body', '.app', '.topbar', '.topnav', '.content', '.page'];
        const sizes = Object.fromEntries(
          selectors.map((selector) => {
            const element = document.querySelector(selector);
            return [
              selector,
              element
                ? { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }
                : null,
            ];
          })
        );
        return {
          sizes,
          shell: {
            hasSidebar: Boolean(document.querySelector('.sidebar')),
            hasTopbar: Boolean(document.querySelector('.topbar')),
            contentWidth: document.querySelector('.content')?.clientWidth ?? 0,
            viewportWidth: document.documentElement.clientWidth,
          },
        };
      });
      const overflow = Object.entries(layout.sizes)
        .filter(([selector]) => selector !== '.topnav')
        .filter(([, size]) => size && size.scrollWidth > size.clientWidth + 1)
        .map(([selector, size]) => `${selector} ${size.clientWidth}/${size.scrollWidth}`);
      if (overflow.length) {
        throw new Error(`${viewport.name} ${route} 存在横向溢出：${overflow.join(', ')}`);
      }
      if (layout.shell.hasSidebar || !layout.shell.hasTopbar) {
        throw new Error(`${viewport.name} ${route} 顶部导航骨架异常`);
      }
      if (layout.shell.contentWidth < layout.shell.viewportWidth - 1) {
        throw new Error(
          `${viewport.name} ${route} 内容区未占满宽度：`
          + `${layout.shell.contentWidth}/${layout.shell.viewportWidth}`
        );
      }
      if (errors.length) {
        throw new Error(`${viewport.name} ${route} 浏览器报错：${errors.join(' | ')}`);
      }
      report.push({ viewport: viewport.name, route, overflow: false });
    }

    if (viewport.name === 'desktop') {
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.evaluate(() => localStorage.removeItem('pi-sessions-theme'));
      await page.reload({ waitUntil: 'networkidle' });
      const modes = [];
      for (let index = 0; index < 4; index += 1) {
        modes.push(await page.evaluate(() => document.documentElement.dataset.theme));
        if (index < 3) await page.locator('.theme-toggle').click();
      }
      if (modes.join(',') !== 'auto,light,dark,auto') {
        throw new Error(`主题循环异常：${modes.join(' → ')}`);
      }
    }
    await context.close();
  }
  console.log(JSON.stringify({ sessionId, checks: report.length, report }, null, 2));
} finally {
  await browser.close();
}
