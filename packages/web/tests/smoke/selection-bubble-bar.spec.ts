// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 选中浮出条的 E2E（任务 #112）。
 *
 * 这里只放 jsdom 量不了的那些：位置、翻转、裁切、跟随滚动、焦点环——它们
 * 全部依赖真实布局，而 jsdom 里每个矩形都是零。命令按下去文档变没变已经由
 * 单测逐个钉住，这里不重复。
 *
 * 需要 dev 起着 + smoke 账号：
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.use({ viewport: { width: 1680, height: 950 } });

/** 登录并进到一个新建的 Document Space，返回正文元素的定位器。 */
async function openFreshDocument(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });

  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });

  await page.getByTestId('new-space-button').click();
  await page.getByTestId('new-space-type-document').click();
  await page.getByTestId('new-space-name').fill(`bubble-${Date.now()}`);
  await page.getByTestId('new-space-submit').click();

  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // 新建 Space 的对话框关闭时会把焦点异步还给它的触发按钮；等它还完再动，
  // 否则接下来的输入会被那个按钮吃掉（#123 的 E2E 踩过这个）。
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  await expect(editor).toBeFocused();
}

/** 选中正文第一段的全部文字。 */
async function selectFirstParagraph(page: Page): Promise<void> {
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
}

test('浮出条浮在选区上方、贴左边缘，且不被滚动容器裁掉', async ({ page }) => {
  test.setTimeout(120_000);
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await page.keyboard.type('the quick brown fox jumps over the lazy dog');

  await selectFirstParagraph(page);
  const bar = page.getByTestId('doc-selection-bubble-bar');
  await expect(bar).toBeVisible();

  // A6：贴选区上方 8px、左边缘对齐选区左边缘。
  const geo = await page.evaluate(() => {
    const sel = window.getSelection();
    const line = sel?.getRangeAt(0).getClientRects()[0];
    const el = document.querySelector('[data-testid="doc-selection-bubble-bar"]');
    const b = el?.getBoundingClientRect();
    const cs = el ? getComputedStyle(el) : null;
    return {
      gap: line && b ? Math.round(line.top - b.bottom) : null,
      leftDelta: line && b ? Math.round(b.left - line.left) : null,
      borderWidth: cs?.borderTopWidth,
      hasShadow: cs ? cs.boxShadow !== 'none' : false,
      radius: cs?.borderTopLeftRadius,
    };
  });
  expect(geo.gap).toBe(8);
  expect(Math.abs(geo.leftDelta ?? 999)).toBeLessThanOrEqual(1);
  expect(geo.borderWidth).toBe('1px');
  expect(geo.hasShadow).toBe(true);

  // A5：不被滚动容器裁掉——它挂在滚动容器外面。
  const outsideScroller = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="doc-selection-bubble-bar"]');
    return el ? el.closest('.doc-body-scroller') === null : false;
  });
  expect(outsideScroller).toBe(true);

  // A9：键盘可达，且焦点看得见。
  await page.keyboard.press('Tab');
  const focusVisible = await page.evaluate(() => {
    const active = document.activeElement;
    const inBar = !!active?.closest('[data-testid="doc-selection-bubble-bar"]');
    const cs = active ? getComputedStyle(active) : null;
    return { inBar, ring: cs?.outlineStyle !== 'none' || cs?.boxShadow !== 'none' };
  });
  expect(focusVisible.inBar).toBe(true);
  expect(focusVisible.ring).toBe(true);

  await expect(editor).toBeAttached();
});

test('正文滚动时浮出条跟着选区走，不停在原地', async ({ page }) => {
  test.setTimeout(120_000);
  await openFreshDocument(page);
  // 造出一篇够长的正文，好让它真的能滚。
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.type(`line ${i} of a document long enough to scroll`);
    await page.keyboard.press('Enter');
  }

  await selectFirstParagraph(page);
  const bar = page.getByTestId('doc-selection-bubble-bar');
  await expect(bar).toBeVisible();

  const before = await bar.boundingBox();
  await page.evaluate(() => {
    document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.scrollBy(0, 300);
  });
  // 位置重算是插件监听 scroll 之后做的，给它一帧。
  await expect
    .poll(async () => (await bar.boundingBox())?.y, { timeout: 5_000 })
    .not.toBe(before?.y);
});
