// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 整篇文档命令那个入口的 E2E（任务 #129）。
 *
 * 这里只放 jsdom 量不了的那些：入口在屏幕上的实际位置、常驻面积、点开之后
 * 菜单画在哪儿、以及顶部横条真的从渲染树上消失了。展开后装哪两项、每项的
 * 尚未开放态由 `document-menu-entry.test.tsx` 逐条钉住（jsdom 答得了），
 * 这里不重复。
 *
 * 需要 dev 起着 + smoke 账号：
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

// 一次登录，全文件共用一个页面 —— 登录限流是 5 次每分钟，理由同
// `selection-bubble-bar.spec.ts`。
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
});

test.afterAll(async () => {
  await page?.close();
});

/** 进到一个新建的 Document Space。 */
async function openFreshDocument(p: Page): Promise<void> {
  await p.goto('/studio');
  const firstProject = p.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await p.waitForURL(/\/project\//, { timeout: 15_000 });

  await p.getByTestId('new-space-button').click();
  await p.getByTestId('new-space-type-document').click();
  await p.getByTestId('new-space-name').fill(`doc-menu-${Date.now()}`);
  await p.getByTestId('new-space-submit').click();

  const editor = p.locator('[data-testid="document-space"] .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15_000 });
}

test('顶部横条真的不在渲染树上了', async () => {
  await openFreshDocument(page);
  // 前缀查而不是逐个点名：要断言的是「一个都没有」。
  await expect(page.locator('[data-testid^="doc-toolbar-tool-"]')).toHaveCount(0);
  await expect(page.getByTestId('document-toolbar')).toHaveCount(0);
});

test('常驻在正文区上的只有那一个入口，32×32，贴右上角', async () => {
  await openFreshDocument(page);
  const trigger = page.getByTestId('doc-doc-menu-trigger');
  await expect(trigger).toBeVisible({ timeout: 10_000 });

  const geometry = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="doc-doc-menu-trigger"]')!;
    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    )!;
    const tb = t.getBoundingClientRect();
    const vb = viewport.getBoundingClientRect();
    return {
      width: Math.round(tb.width),
      height: Math.round(tb.height),
      // 贴右上角 —— 距离现场量，不写死：正文区的位置会随外壳变。
      insetRight: Math.round(vb.right - tb.right),
      insetTop: Math.round(tb.top - vb.top),
      // 打在它自己身上：命中自己才说明那块像素真的画出来了。
      hitsItself: !!document
        .elementFromPoint(tb.left + tb.width / 2, tb.top + tb.height / 2)
        ?.closest('[data-testid="doc-doc-menu-trigger"]'),
    };
  });

  expect(geometry.width).toBe(32);
  expect(geometry.height).toBe(32);
  expect(geometry.insetRight).toBeGreaterThan(0);
  expect(geometry.insetRight).toBeLessThan(40);
  expect(geometry.insetTop).toBeGreaterThan(0);
  expect(geometry.insetTop).toBeLessThan(40);
  expect(geometry.hitsItself).toBe(true);
});

test('点开出菜单，菜单落在入口下方且没被裁掉', async () => {
  await openFreshDocument(page);
  const trigger = page.getByTestId('doc-doc-menu-trigger');
  await expect(trigger).toBeVisible({ timeout: 10_000 });

  // 展开之前，命令一个都不在屏上 —— 这条是「常驻面积恒定」的另一半。
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toHaveCount(0);

  await trigger.click();
  const item = page.getByTestId('doc-doc-menu-save-snapshot');
  await expect(item).toBeVisible({ timeout: 5_000 });

  const placement = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="doc-doc-menu-trigger"]')!;
    const i = document.querySelector(
      '[data-testid="doc-doc-menu-save-snapshot"]',
    )!;
    const tb = t.getBoundingClientRect();
    const ib = i.getBoundingClientRect();
    return {
      below: ib.top >= tb.bottom - 1,
      insideWindow:
        ib.left >= 0 &&
        ib.top >= 0 &&
        ib.right <= window.innerWidth &&
        ib.bottom <= window.innerHeight,
      hitsItself: !!document
        .elementFromPoint(ib.left + ib.width / 2, ib.top + ib.height / 2)
        ?.closest('[data-testid="doc-doc-menu-save-snapshot"]'),
    };
  });

  expect(placement.below).toBe(true);
  expect(placement.insideWindow).toBe(true);
  expect(placement.hitsItself).toBe(true);
});

test('点尚未开放的那一项，菜单不关、文档不变', async () => {
  await openFreshDocument(page);
  await page.getByTestId('doc-doc-menu-trigger').click();
  const item = page.getByTestId('doc-doc-menu-save-snapshot');
  await expect(item).toBeVisible({ timeout: 5_000 });

  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  const before = await editor.innerHTML();
  // `force` 跳过 playwright 自己的可点性检查 —— 它把 `aria-disabled` 当成不可
  // 点，而浏览器不看这个属性：真实用户点下去，事件照常派发，靠 `onSelect` 里
  // 的 preventDefault 拦住。不加 force 就等不到「enabled」，一直重试到超时，
  // 测的成了框架的保护而不是产品的行为。
  await item.click({ force: true });

  // `onSelect` 里 preventDefault：菜单留在原地，文档一个字没变。
  await expect(item).toBeVisible();
  expect(await editor.innerHTML()).toBe(before);
});

test('点正文那一下既关掉菜单，也让光标落进正文', async () => {
  // 用户开着菜单、想回去接着写，点正文一下就该能写。默认的 modal 菜单会在
  // body 上加 `pointer-events: none` 把那次点击吞掉，只用来关菜单，焦点还被
  // 还给触发器 —— 于是要点两次才写得了字（实测）。
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  await page.keyboard.type('第一句。');

  const trigger = page.getByTestId('doc-doc-menu-trigger');
  const box = (await trigger.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toBeVisible({
    timeout: 5_000,
  });

  const eb = (await editor.boundingBox())!;
  await page.mouse.click(eb.x + 200, eb.y + 30);
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toHaveCount(0);

  await page.keyboard.type('第二句。');
  await expect(editor).toContainText('第二句。', { timeout: 5_000 });
});

test('再点一次入口收起菜单', async () => {
  // user 2026-08-22 要的形态：「点击小按钮，这一排按钮就会弹出来；再点一下，
  // 这一排按钮就消失了。」用真实鼠标坐标点，不走 playwright 的可点性检查 ——
  // 菜单开着时它会认为触发器被上层拦住。
  await openFreshDocument(page);
  const trigger = page.getByTestId('doc-doc-menu-trigger');
  const box = (await trigger.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.click(cx, cy);
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toBeVisible({
    timeout: 5_000,
  });

  await page.mouse.click(cx, cy);
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toHaveCount(0);
});

test('按 Escape 收起菜单', async () => {
  await openFreshDocument(page);
  await page.getByTestId('doc-doc-menu-trigger').click();
  const item = page.getByTestId('doc-doc-menu-save-snapshot');
  await expect(item).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press('Escape');
  await expect(item).toHaveCount(0);
});
