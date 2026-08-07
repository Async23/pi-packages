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
const sessionsResponse = await fetch(`${baseUrl}/api/sessions?limit=30`);
if (!sessionsResponse.ok) {
  throw new Error(`无法读取会话列表：HTTP ${sessionsResponse.status}`);
}
const sessions = await sessionsResponse.json();
const session = process.env.PI_SESSION_ID
  ? { id: process.env.PI_SESSION_ID }
  : sessions.items?.find(
    (item) =>
      item.counts?.user > 0
      && item.counts?.thinkingBlocks > 0
      && item.counts?.toolCalls > 0
  );
if (!session?.id) throw new Error('没有可用于阅读控制检查的会话');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));

  await page.goto(`${baseUrl}/sessions/${session.id}`, { waitUntil: 'networkidle' });
  const directory = page.locator('.session-directory-card');
  await directory.waitFor({ state: 'visible' });

  if (await page.locator('.reader-toolbar').count()) {
    throw new Error('旧 reader-toolbar 仍然存在');
  }

  const firstAsideTitle = await page
    .locator('.detail-aside > .card')
    .first()
    .locator('.card-title')
    .textContent();
  if (!firstAsideTitle?.includes('阅读与定位')) {
    throw new Error(`右侧第一张卡片不是“阅读与定位”：${firstAsideTitle || '(空)'}`);
  }

  const turnCount = await directory.locator('.session-directory-turn').count();
  if (!turnCount) throw new Error('会话目录没有生成用户轮次');

  const overflowY = await directory.locator('.session-directory-scroll').evaluate(
    (node) => getComputedStyle(node).overflowY
  );
  if (overflowY !== 'auto' && overflowY !== 'scroll') {
    throw new Error(`会话目录没有独立滚动：overflow-y=${overflowY}`);
  }

  const firstToolCard = page.locator('.tool-card:has(> .tool-collapsible)').first();
  if (!await firstToolCard.count()) throw new Error('找不到可检查的工具卡');
  const toolCardChrome = await firstToolCard.evaluate((card) => {
    const collapsible = card.querySelector(':scope > .tool-collapsible');
    const cardStyle = getComputedStyle(card);
    const collapsibleStyle = getComputedStyle(collapsible);
    return {
      outerBorder: cardStyle.borderTopWidth,
      innerBorder: collapsibleStyle.borderTopWidth,
      innerMarginTop: collapsibleStyle.marginTop,
      innerMarginBottom: collapsibleStyle.marginBottom,
      innerRadius: collapsibleStyle.borderTopLeftRadius,
    };
  });
  if (toolCardChrome.outerBorder === '0px') {
    throw new Error('工具卡外层状态边框丢失');
  }
  if (
    toolCardChrome.innerBorder !== '0px'
    || toolCardChrome.innerMarginTop !== '0px'
    || toolCardChrome.innerMarginBottom !== '0px'
    || toolCardChrome.innerRadius !== '0px'
  ) {
    throw new Error(`工具卡仍有双层容器样式：${JSON.stringify(toolCardChrome)}`);
  }
  await firstToolCard.locator(':scope > .tool-collapsible > .collapsible-head').click();
  const innerBodyPadding = await firstToolCard
    .locator(':scope > .tool-collapsible > .collapsible-body')
    .evaluate((body) => {
      const style = getComputedStyle(body);
      return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
    });
  if (innerBodyPadding.some((value) => value !== '0px')) {
    throw new Error(`工具卡展开内容仍有冗余内边距：${innerBodyPadding.join(' ')}`);
  }

  const toolTurn = directory
    .locator('.session-directory-turn[data-tool-count]:not([data-tool-count="0"])')
    .first();
  if (!await toolTurn.count()) throw new Error('找不到包含工具调用的用户轮次');
  await toolTurn.locator(':scope > .session-directory-turn-row').click();
  await page.waitForFunction(
    () => document.querySelector('.session-directory-turn.is-current')?.dataset.toolCount !== '0'
  );

  const stepWithDetails = toolTurn
    .locator('[data-directory-step-id]:not([data-detail-count="0"])')
    .first();
  const stepId = await stepWithDetails.getAttribute('data-directory-step-id');
  if (!stepId) throw new Error('找不到包含思考或工具的 π 步骤');
  await stepWithDetails.click();

  await page.waitForFunction(
    (id) => document.querySelector(`[data-directory-step-id="${id}"]`)?.classList.contains('is-current'),
    stepId
  );
  const detailGroups = await directory.locator('.session-directory-details').count();
  if (detailGroups !== 1) {
    throw new Error(`B×D 应只展开当前步骤的一层详情，实际详情组数=${detailGroups}`);
  }
  const currentDetailVisible = await directory.evaluate((card) => {
    const viewport = card.querySelector('.session-directory-scroll')?.getBoundingClientRect();
    const details = card
      .querySelector('.session-directory-step.is-current .session-directory-details')
      ?.getBoundingClientRect();
    return Boolean(
      viewport
      && details
      && details.top >= viewport.top
      && details.bottom <= viewport.bottom
    );
  });
  if (!currentDetailVisible) throw new Error('当前步骤的一层详情没有完整显示在目录视口内');

  await page.waitForFunction((id) => {
    const container = document.querySelector('.content');
    const target = document.getElementById(`entry-${id}`);
    if (!container || !target) return false;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return targetRect.top >= containerRect.top - 2
      && targetRect.top <= containerRect.top + container.clientHeight * 0.35;
  }, stepId);

  const detailButton = directory.locator('.session-directory-detail').first();
  const detailAnchor = await detailButton.getAttribute('data-directory-detail-anchor');
  if (!detailAnchor) throw new Error('目录详情缺少精确锚点');
  await detailButton.click();
  await page.waitForFunction((anchorId) => {
    const container = document.querySelector('.content');
    const target = document.getElementById(anchorId);
    if (!container || !target) return false;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return targetRect.top >= containerRect.top - 2
      && targetRect.top <= containerRect.top + container.clientHeight * 0.35;
  }, detailAnchor);

  const firstEntryWithLink = page.locator('.entry:has(.entry-link)').first();
  const entryId = await firstEntryWithLink.getAttribute('data-entry-id');
  if (!entryId) throw new Error('找不到可复制链接的消息');
  await firstEntryWithLink.locator('.entry-link').click();
  await page.waitForFunction(
    () => document.querySelector('.entry-link.copied')?.textContent.includes('已复制')
  );
  const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
  if (!copiedLink.endsWith(`#entry-${entryId}`)) {
    throw new Error(`复制链接异常：${copiedLink}`);
  }

  if (errors.length) {
    throw new Error(`浏览器报错：${errors.join(' | ')}`);
  }

  console.log(JSON.stringify({
    sessionId: session.id,
    turnCount,
    activeStepId: stepId,
    detailAnchor,
    copiedLink,
  }, null, 2));

  await context.close();
} finally {
  await browser.close();
}
