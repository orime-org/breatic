// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 块类型菜单的 E2E（任务 #904）。
 *
 * 这里放 jsdom 到不了的那半：真的按下八个快捷键、真的用指针打开菜单点一行，
 * 以及对勾和分隔线在真实布局里的位置——jsdom 里每个矩形都是零，位置量不了，
 * 而按键在那儿是手动喂给 `handleKeyDown` 的，浏览器自己那一层没被走过。
 *
 * 每一格的产物由单测逐格钉住（`__tests__/block-type-transitions.test.ts` 等
 * 六个文件），这里不重复，只走通路径并抽查关键几格。
 *
 * 需要 dev 起着 + smoke 账号：
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

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

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

/** 这一轮在哪个 project 里跑；不给就走 studio 首页最上面那个。 */
const projectUrl = process.env.SMOKE_PROJECT_URL;

const SLOT = 'doc-bubble-block-type';
const EDITOR = '[data-testid="document-space"] .ProseMirror';

/** macOS 上是 ⌘，别处是 Ctrl。 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * 进到一个新建的 Document Space，光标已在正文里。
 * @param p - 页面。
 */
async function openFreshDocument(p: Page): Promise<void> {
  if (projectUrl === undefined) {
    await p.goto('/studio');
    const firstProject = p.locator('a[href^="/project/"]').first();
    await expect(firstProject).toBeVisible({ timeout: 15_000 });
    await firstProject.click();
  } else {
    await p.goto(projectUrl);
  }
  await p.waitForURL(/\/project\//, { timeout: 15_000 });

  createdSpaceIds.push(await createSpace(p, 'document', `blocktype-${Date.now()}`));

  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // 新建 Space 的对话框关闭时把焦点异步还给触发按钮；等它还完再动，否则接下来
  // 的输入会被那个按钮吃掉。
  await expect(p.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  await expect(editor).toBeFocused();
}

/**
 * 打一行字，然后把它整行选中。
 * @param p - 页面。
 * @param text - 要打的字。
 */
async function typeAndSelectLine(p: Page, text: string): Promise<void> {
  await p.keyboard.type(text);
  await p.keyboard.press(`${MOD}+a`);
  await expect(p.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
}

/**
 * 正文现在的 HTML，去掉占位属性。
 * @param p - 页面。
 * @returns 正文的 HTML。
 */
async function bodyHtml(p: Page): Promise<string> {
  return p.evaluate(
    (sel) =>
      document.querySelector(sel)!.innerHTML.replace(/ data-block-placeholder="[^"]*"/g, ''),
    EDITOR,
  );
}

/**
 * 把指针移到块类型格位上，等它的菜单出来。
 * @param p - 页面。
 */
async function openBlockTypeMenu(p: Page): Promise<void> {
  await p.getByTestId(SLOT).hover();
  await expect(p.getByTestId(`${SLOT}-menu`)).toBeVisible({ timeout: 10_000 });
}

test('九行各点一次，文档每次都跟着变', async () => {
  await openFreshDocument(page);
  await typeAndSelectLine(page, 'a line the menu will work on');

  const expected: Array<[id: string, html: string]> = [
    ['heading-1', '<h1>a line the menu will work on</h1>'],
    ['heading-2', '<h2>a line the menu will work on</h2>'],
    ['heading-3', '<h3>a line the menu will work on</h3>'],
    ['bullet-list', '<ul><li><p>a line the menu will work on</p></li></ul>'],
    ['ordered-list', '<ol><li><p>a line the menu will work on</p></li></ol>'],
    ['code-block', '<pre><code>a line the menu will work on</code></pre>'],
    ['paragraph', '<p>a line the menu will work on</p>'],
    ['quote', '<blockquote><p>a line the menu will work on</p></blockquote>'],
  ];

  for (const [id, html] of expected) {
    await openBlockTypeMenu(page);
    await page.getByTestId(`${SLOT}-item-${id}`).click();
    await expect
      .poll(async () => bodyHtml(page), { timeout: 10_000 })
      .toBe(html);
    // 点第一个块本身，不点编辑器容器：点在末块下方的空白处会让
    // `DocumentClickToWrite` 在文档末尾补一个新块（既有功能），下一轮的
    // 全选就多框住一个块。
    await page.locator(`${EDITOR} > *`).first().click();
    await page.keyboard.press(`${MOD}+a`);
  }

  // To-do list 是第九行，灰着、没有 schema 节点（#13）。
  await openBlockTypeMenu(page);
  await expect(page.getByTestId(`${SLOT}-item-task-list`)).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('八个快捷键各按一次，结果跟点那一行相同', async () => {
  await openFreshDocument(page);
  await typeAndSelectLine(page, 'a line the keys will work on');

  const chords: Array<[chord: string, html: string]> = [
    [`${MOD}+Alt+1`, '<h1>a line the keys will work on</h1>'],
    [`${MOD}+Alt+2`, '<h2>a line the keys will work on</h2>'],
    [`${MOD}+Alt+3`, '<h3>a line the keys will work on</h3>'],
    [`${MOD}+Shift+8`, '<ul><li><p>a line the keys will work on</p></li></ul>'],
    [`${MOD}+Shift+7`, '<ol><li><p>a line the keys will work on</p></li></ol>'],
    [`${MOD}+Alt+c`, '<pre><code>a line the keys will work on</code></pre>'],
    [`${MOD}+Alt+0`, '<p>a line the keys will work on</p>'],
    [`${MOD}+Shift+b`, '<blockquote><p>a line the keys will work on</p></blockquote>'],
  ];

  for (const [chord, html] of chords) {
    await page.keyboard.press(chord);
    await expect.poll(async () => bodyHtml(page), { timeout: 10_000 }).toBe(html);
    await page.keyboard.press(`${MOD}+a`);
  }
});

test('引用里的列表：点标题只动块，点引用只脱引用', async () => {
  await openFreshDocument(page);
  await typeAndSelectLine(page, 'quoted list item');
  // 先做成列表，再套引用。
  await page.keyboard.press(`${MOD}+Shift+8`);
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+b`);
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<blockquote><ul><li><p>quoted list item</p></li></ul></blockquote>');

  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Alt+1`);
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<blockquote><h1>quoted list item</h1></blockquote>');

  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+b`);
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<h1>quoted list item</h1>');
});

test('对勾在快捷键右边，分隔线在 Code block 之后', async () => {
  await openFreshDocument(page);
  await typeAndSelectLine(page, 'a heading to tick');
  await page.keyboard.press(`${MOD}+Alt+1`);
  await page.keyboard.press(`${MOD}+a`);
  await openBlockTypeMenu(page);

  // 勾在 Heading 1 那一行，且只在那一行。
  const ticks = page.locator(`[data-testid^="${SLOT}-tick-"]`);
  await expect(ticks).toHaveCount(1);
  await expect(page.getByTestId(`${SLOT}-tick-heading-1`)).toBeVisible();

  const geometry = await page.evaluate((slot) => {
    const rect = (testid: string): DOMRect | null =>
      document.querySelector(`[data-testid="${testid}"]`)?.getBoundingClientRect() ?? null;
    const shortcut = rect(`${slot}-shortcut-heading-1`);
    const tick = rect(`${slot}-tick-heading-1`);
    const shortcutRights = ['heading-1', 'heading-2', 'heading-3'].map(
      (id) => Math.round(rect(`${slot}-shortcut-${id}`)?.right ?? -1),
    );
    const codeBlock = rect(`${slot}-item-code-block`);
    const quote = rect(`${slot}-item-quote`);
    const rule = document
      .querySelector(`[data-testid="${slot}-menu"] [data-testid="doc-bubble-rule"]`)
      ?.getBoundingClientRect() ?? null;
    return {
      tickLeft: tick?.left ?? null,
      shortcutRight: shortcut?.right ?? null,
      sameRow: shortcut && tick
        ? Math.abs((shortcut.top + shortcut.height / 2) - (tick.top + tick.height / 2)) < 4
        : false,
      ruleTop: rule?.top ?? null,
      codeBlockBottom: codeBlock?.bottom ?? null,
      quoteTop: quote?.top ?? null,
      activeRows: document.querySelectorAll(
        `[data-testid="${slot}-menu"] [data-active="true"]`,
      ).length,
      shortcutRights,
    };
  }, SLOT);

  // demo 把勾画在快捷键右边，同一行上。
  expect(geometry.sameRow).toBe(true);
  expect(geometry.tickLeft).not.toBeNull();
  expect(geometry.shortcutRight).not.toBeNull();
  expect(geometry.tickLeft as number).toBeGreaterThan(geometry.shortcutRight as number);

  // 分隔线夹在 Code block 和 Quote 之间。
  expect(geometry.ruleTop as number).toBeGreaterThanOrEqual(
    geometry.codeBlockBottom as number,
  );
  expect(geometry.quoteTop as number).toBeGreaterThanOrEqual(geometry.ruleTop as number);

  // 每行都留着对勾那一格，所以打勾那行的快捷键跟别的行仍在同一条线上
  // （demo 的 `.row .tick`）。
  expect(new Set(geometry.shortcutRights).size).toBe(1);
  expect(geometry.shortcutRights[0]).toBeGreaterThan(0);

  // 行底色没了，勾是唯一的标记。
  expect(geometry.activeRows).toBe(0);
});
