// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 选中浮出条的 E2E（任务 #112）。
 *
 * 这里只放 jsdom 量不了的那些：位置、裁切、跟随滚动、焦点环、明暗两套的视觉
 * 规格——它们全部依赖真实布局，而 jsdom 里每个矩形都是零。命令按下去文档变没变
 * 由单测逐个钉住，锚点选哪一行也由单测钉住（那两处 jsdom 答得了），这里不重复。
 *
 * 需要 dev 起着 + smoke 账号：
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.use({ viewport: { width: 1680, height: 950 } });

/** 登录并进到一个新建的 Document Space，光标已在正文里。 */
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

for (const scheme of ['light', 'dark'] as const) {
  test(`浮出条的位置和视觉规格（${scheme}）`, async ({ page }) => {
    test.setTimeout(120_000);
    // 主题跟随系统，所以模拟系统配色就是走产品自己那条路（`useThemeMode` 订阅
    // `prefers-color-scheme`，把结果写进 `<html data-theme>`）。
    await page.emulateMedia({ colorScheme: scheme });
    await openFreshDocument(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);

    await page.keyboard.type('the quick brown fox jumps over the lazy dog');
    await selectFirstParagraph(page);
    const bar = page.getByTestId('doc-selection-bubble-bar');
    await expect(bar).toBeVisible();

    const geo = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="doc-selection-bubble-bar"]',
      ) as HTMLElement;
      const b = el.getBoundingClientRect();
      const line = window.getSelection()?.getRangeAt(0).getClientRects()[0];
      const cs = getComputedStyle(el);
      // 底色比对不写死颜色字面量：临时放一个只声明了那个 token 的元素，读它
      // 算出来的颜色。明暗两套、以后改 token 值，这条断言都还成立，而写死
      // `rgb(245,245,245)` 只在浅色下、且只在今天成立。
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--color-popover)';
      document.body.appendChild(probe);
      const tokenBackground = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const buttons = Array.from(
        el.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
      ).map((n) => {
        const r = n.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height) };
      });
      // A5：最上层命中的真的是浮出条自己——比「它在 DOM 里」强，能同时排除
      // 被裁掉一半和被别的东西盖住。
      const hit = document.elementFromPoint(
        b.left + b.width / 2,
        b.top + b.height / 2,
      );
      return {
        gap: line ? Math.round(line.top - b.bottom) : null,
        leftDelta: line ? Math.round(b.left - line.left) : null,
        borderWidth: cs.borderTopWidth,
        radius: cs.borderTopLeftRadius,
        tokenRadius: getComputedStyle(document.documentElement)
          .getPropertyValue('--radius-overlay')
          .trim(),
        background: cs.backgroundColor,
        tokenBackground,
        hasShadow: cs.boxShadow !== 'none',
        buttons,
        hitInsideBar: !!hit?.closest('[data-testid="doc-selection-bubble-bar"]'),
        insideScroller: !!el.closest('.doc-body-scroller'),
        aboveWindowTop: b.top < 0,
      };
    });

    // A6：贴选区上方 8px、左边缘对齐选区左边缘。
    expect(geo.gap).toBe(8);
    expect(Math.abs(geo.leftDelta ?? 999)).toBeLessThanOrEqual(1);
    // A6：定稿 §5 的四样——底、边、圆角、阴影。
    expect(geo.background).toBe(geo.tokenBackground);
    expect(geo.borderWidth).toBe('1px');
    expect(geo.radius).toBe(geo.tokenRadius);
    expect(geo.hasShadow).toBe(true);
    // demo 的 `.pop .tb-btn`（:209）只覆盖高度，`.tb-btn` 自己的
    // `min-width: 28px`（:138-139）仍然生效，所以是 26 高、28 宽。
    expect(geo.buttons).toHaveLength(6);
    for (const b of geo.buttons) {
      expect(b).toEqual({ width: 28, height: 26 });
    }
    // A5：挂在滚动容器外面、最上层可见、没跑出窗口。
    expect(geo.insideScroller).toBe(false);
    expect(geo.hitInsideBar).toBe(true);
    expect(geo.aboveWindowTop).toBe(false);
  });
}

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

test('窗口再矮，浮出条也放得下、不越出窗口顶', async ({ page }) => {
  test.setTimeout(120_000);
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox jumps over the lazy dog');

  // 这条钉的是「上方够不够放」这件事本身。实测（2026-08-19，四个窗口高度
  // 950 / 600 / 420 / 300）正文滚动容器的顶恒在离窗口顶 120px —— 顶部那排
  // chrome 是固定高度，不随窗口缩，所以浮出条要的 44px（36 高 + 8 间距）
  // 永远有。`options.flip` 因此是一张用不上的保险，不是这条在验的东西。
  await page.setViewportSize({ width: 1680, height: 300 });
  await selectFirstParagraph(page);
  const bar = page.getByTestId('doc-selection-bubble-bar');
  await expect(bar).toBeVisible();

  const m = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement;
    const b = el.getBoundingClientRect();
    const vp = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    ) as HTMLElement;
    const line = window.getSelection()?.getRangeAt(0).getClientRects()[0];
    return {
      barTop: b.top,
      gap: line ? Math.round(line.top - b.bottom) : null,
      roomAboveText: Math.round(vp.getBoundingClientRect().top),
      hitInsideBar: !!document
        .elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
        ?.closest('[data-testid="doc-selection-bubble-bar"]'),
    };
  });

  expect(m.roomAboveText).toBe(120);
  expect(m.barTop).toBeGreaterThanOrEqual(0);
  expect(m.gap).toBe(8);
  expect(m.hitInsideBar).toBe(true);
});

test('Tab 进浮出条，焦点看得见', async ({ page }) => {
  test.setTimeout(120_000);
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox jumps over the lazy dog');
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  // 先记下没聚焦时第一个按钮长什么样，Tab 之后跟它比。
  // 直接断言「有 outline 或有 box-shadow」是句永远成立的话：按钮本来就可能
  // 带阴影，而 `getComputedStyle(null)` 这种写法连没有焦点元素时都为真。
  const first = page.getByTestId('doc-bubble-tool-bold');
  const idle = await first.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { outline: cs.outlineStyle, shadow: cs.boxShadow };
  });

  await page.keyboard.press('Tab');

  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return null;
    const cs = getComputedStyle(active);
    return {
      testid: active.getAttribute('data-testid'),
      inBar: !!active.closest('[data-testid="doc-selection-bubble-bar"]'),
      outline: cs.outlineStyle,
      shadow: cs.boxShadow,
    };
  });

  expect(focused).not.toBeNull();
  expect(focused?.inBar).toBe(true);
  // 焦点落在浮出条自己的按钮上，而且它的样子跟没聚焦时不一样——变的是描边
  // 还是环都算，但必须真的变了。
  const changed =
    focused?.outline !== idle.outline || focused?.shadow !== idle.shadow;
  expect(changed).toBe(true);
});
