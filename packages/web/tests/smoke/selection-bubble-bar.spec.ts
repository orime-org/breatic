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

/** 正文可见区的顶距窗口顶多少 —— 顶部那排 chrome 是固定高度，实测恒为它。 */
const BODY_VIEWPORT_TOP = 120;

// 一次登录，全文件共用一个页面。登录限流是 5 次每分钟，而这里有 7 条用例——
// 每条各登一次必然从第六条起全部超时在登录页上（实测）。串行加共用页面既避开
// 限流，也避开「同一个账号同时开好几个会话」这种本文件不打算测的东西。
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

/** 进到一个新建的 Document Space，光标已在正文里。 */
async function openFreshDocument(page: Page): Promise<void> {
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

/**
 * 三击选中第 i 段。
 *
 * 不用 `Shift+End`：macOS 上 `End` 是「跳到文档末尾」不是「行尾」，那样选到的
 * 是从点击处到全文结尾，head 落在最后一行，量到的完全是另一个场景（实测）。
 *
 * 先把上一次的选区收掉、等浮出条真的从 DOM 里消失，再三击。少了这一步，第二
 * 次调用时浮出条本来就还在屏上，`toBeVisible` 当场返回，量到的是它**还没重算
 * 完**的旧位置（插件对选区变化有 250ms 防抖）—— 实测因此量出过 237px 的间距，
 * 而单独跑同一个场景是 8。
 *
 * 收选区用按键不用点击：单击之后紧接着三击，浏览器会把它们拼成一串更多次的
 * 点击，选中的就不是一整段了 —— 实测那样量出来的锚点落在**下一段**上，浮出条
 * 正好压在选中的那一行上（444 到 480 压着 451 到 470）。
 */
async function selectParagraph(page: Page, i: number): Promise<void> {
  const paragraph = page
    .locator('[data-testid="document-space"] .ProseMirror p')
    .nth(i);
  const bar = page.getByTestId('doc-selection-bubble-bar');

  if (await bar.isVisible()) {
    await page.keyboard.press('ArrowRight');
    await expect(bar).not.toBeAttached({ timeout: 5_000 });
  }
  await paragraph.click({ clickCount: 3 });
  await expect(bar).toBeVisible({ timeout: 5_000 });
}

/** 把正文滚动容器停在一个绝对位置，并给插件一帧去重算。 */
async function scrollBodyTo(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => {
    document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.scrollTo(0, top);
  }, y);
  await page.waitForTimeout(400);
}

/** 敲出一篇够长、能滚起来的正文。 */
async function typeLongBody(page: Page): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.type(`line ${i} of a document long enough to scroll`);
    await page.keyboard.press('Enter');
  }
}

/** 浮出条、选中那一行、裁切它的那个盒子，三者的位置。 */
async function readGeometry(page: Page): Promise<{
  barTop: number;
  barBottom: number;
  lineTop: number;
  lineBottom: number;
  clipTop: number;
  below: boolean;
  gap: number;
  hitAtOwnTop: boolean;
}> {
  return page.evaluate(() => {
    const bar = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement;
    const b = bar.getBoundingClientRect();
    const line = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    // 真正裁切浮出条的那一层，从它自己往上找第一个会裁的祖先。
    let clipTop = 0;
    for (let n = bar.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/hidden|clip|auto|scroll/.test(cs.overflowY + cs.overflowX)) {
        clipTop = n.getBoundingClientRect().top;
        break;
      }
    }
    const below = !!line && b.top >= line.bottom;
    return {
      barTop: Math.round(b.top),
      barBottom: Math.round(b.bottom),
      lineTop: line ? Math.round(line.top) : 0,
      lineBottom: line ? Math.round(line.bottom) : 0,
      clipTop: Math.round(clipTop),
      below,
      gap: line
        ? Math.round(below ? b.top - line.bottom : line.top - b.bottom)
        : -1,
      // 打在浮出条自己的顶上：命中它自己才说明那一行像素真的画出来了。
      hitAtOwnTop: !!document
        .elementFromPoint(b.left + b.width / 2, b.top + 2)
        ?.closest('[data-testid="doc-selection-bubble-bar"]'),
    };
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`浮出条的位置和视觉规格（${scheme}）`, async () => {
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
      // 选区自己的包围盒——水平轴取的就是它的左边，跟条落在上方还是下方无关。
      const box = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
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
      const below = !!box && b.top >= box.bottom;
      return {
        // 间距按条落在哪一侧算——首段选中时上方放不下，它会翻到下方，
        // 那时「选区顶减条底」是个负数，不是规格没兑现。
        gap: box
          ? Math.round(below ? b.top - box.bottom : box.top - b.bottom)
          : null,
        leftDelta: box ? Math.round(b.left - box.left) : null,
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

    // A6：贴选区 8px、左边缘对齐选区左边缘。
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

test('正文滚动时浮出条跟着选区走，相对位置不变', async () => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);
  // 选中间某一段：它上方空间充足，滚动一小段之后仍然充足，所以整段过程里
  // 浮出条一直在选区上方，可以拿「相对选区的偏移」当不变量。
  await selectParagraph(page, 8);

  const before = await readGeometry(page);
  expect(before.below).toBe(false);
  expect(before.gap).toBe(8);

  await scrollBodyTo(page, 120);

  const after = await readGeometry(page);
  // 只断言「动了」是不够的：条跳到任何地方都能满足。真正的不变量是它跟选中
  // 那一行的相对位置，而那一行自己是随滚动移动的。
  expect(after.lineTop).not.toBe(before.lineTop);
  expect(after.below).toBe(false);
  expect(after.gap).toBe(8);
});

test('上方放不下就翻到选区下方，放得下就留在上方', async () => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  // 首段：它上方到正文可见区顶只有约 30px，而浮出条要 36 高加 8 间距。
  await selectParagraph(page, 0);
  const first = await readGeometry(page);
  expect(first.lineTop - BODY_VIEWPORT_TOP).toBeLessThan(44);
  expect(first.below).toBe(true);
  expect(first.gap).toBe(8);
  // 不断言 barTop >= clipTop：上面已经断言了它在选区下方且间距 8，而选区必在
  // 正文可见区内（顶 120）、裁切盒顶是 80，所以那句话在此恒真、逮不到任何东西。
  // 真正要量的是它有没有被画出来——打在它自己顶上，命中的必须是它自己。
  expect(first.hitAtOwnTop).toBe(true);

  // 中间某段：上方空间充足，照旧在上方。
  await selectParagraph(page, 8);
  const middle = await readGeometry(page);
  expect(middle.lineTop - BODY_VIEWPORT_TOP).toBeGreaterThan(44);
  expect(middle.below).toBe(false);
  expect(middle.gap).toBe(8);

  expect(middle.hitAtOwnTop).toBe(true);
});

test('选中的那一行被滚到正文顶部时，浮出条翻到下方而不是被裁掉', async () => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);
  await selectParagraph(page, 6);

  // 滚到让那一行正好停在正文可见区上沿下面 10px：上方只剩 10，放不下 44。
  // 滚动量按量到的位置算，不写死——写死的数字随字号和行距一起漂，而漂到
  // 「整段滚出视野」时测的就完全是另一件事了（那种情形不在本次范围内）。
  const before = await readGeometry(page);
  await scrollBodyTo(page, before.lineTop - BODY_VIEWPORT_TOP - 10);

  const m = await readGeometry(page);
  expect(m.lineTop - BODY_VIEWPORT_TOP).toBeLessThan(44);
  // 第一轮实现在这里把浮出条画到了裁切盒之外，顶上 4px 被削掉
  // （实测 barTop 76、clipTop 80）。现在它该翻到选区下方。
  expect(m.below).toBe(true);
  expect(m.gap).toBe(8);
  expect(m.hitAtOwnTop).toBe(true);
});

test('浮出条不占 tab 站：从正文按 Tab 不会落进它', async () => {
  test.setTimeout(120_000);
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox jumps over the lazy dog');
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  const landed: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Tab');
    landed.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        if (!active) return 'none';
        return active.closest('[data-testid="doc-selection-bubble-bar"]')
          ? 'in-bar'
          : (active.getAttribute('data-testid') ?? active.tagName);
      }),
    );
  }

  // 连按三次都不许落进浮出条——一次不够：插件把容器设成 tabIndex=0，第一站
  // 是容器、第二站才是第一个按钮，只按一次分辨不出这两种失败。
  expect(landed).not.toContain('in-bar');
});

test('在真浏览器里按浮出条上的按钮，文档真的变了', async () => {
  test.setTimeout(120_000);
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox');
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  const html = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-testid="document-space"] .ProseMirror')
          ?.innerHTML ?? '',
    );

  // 单测里的点击走的是 jsdom 的 `.click()`，它不移动焦点；真机点击会先把焦点
  // 从正文拿走，而浮出条的显示恰恰依赖编辑器的焦点状态。这条走的就是那条路。
  expect(await html()).not.toContain('<strong>');
  await page.getByTestId('doc-bubble-tool-bold').click();
  await expect.poll(html).toContain('<strong>');

  // 按完之后条还在、选区还在，可以接着按第二个命令。
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();
  await page.getByTestId('doc-bubble-tool-italic').click();
  await expect.poll(html).toContain('<em>');
});

test('正文列右边放不下时，浮出条改成右边缘对齐选区左边缘', async () => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshDocument(page);
  await page.keyboard.type(
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi '
    + 'omicron pi rho sigma tau upsilon phi chi psi omega and more words after',
  );

  // 双击行尾那个词：选区左边到正文列右沿的余量小于条宽，flip 的 crossAxis
  // 就会把 `top-start` 翻成 `top-end`。这是水平方向的自适应，跟竖直方向翻到
  // 下方是同一套机制（定稿 §5.1）。
  const spot = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="document-space"] .ProseMirror p');
    const text = p?.firstChild as Text;
    const range = document.createRange();
    // 走一遍每个字符，找出**第一行**上最靠右的那一个。写死「倒数第 7 个字符」
    // 不行：那行字会折行，倒数第 7 个字符多半在第二行的开头，右边余量反而最大
    // ——第一版就是这么写的，量出来余量 345，预置条件根本没成立。
    const first = { top: 0, right: 0, offset: 0 };
    for (let i = 0; i < text.length; i += 1) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const r = range.getBoundingClientRect();
      if (i === 0) first.top = r.top;
      if (Math.abs(r.top - first.top) > 2) break;
      if (r.right > first.right) {
        first.right = r.right;
        first.offset = i;
      }
    }
    range.setStart(text, Math.max(0, first.offset - 2));
    range.setEnd(text, first.offset + 1);
    const r = range.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.dblclick(spot.x, spot.y);
  const bar = page.getByTestId('doc-selection-bubble-bar');
  await expect(bar).toBeVisible({ timeout: 5_000 });

  const m = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement;
    const b = el.getBoundingClientRect();
    const box = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    const column = document
      .querySelector('[data-testid="document-space"] .ProseMirror')
      ?.getBoundingClientRect();
    return {
      roomToTheRight: box && column ? Math.round(column.right - box.left) : null,
      barWidth: Math.round(b.width),
      leftDelta: box ? Math.round(b.left - box.left) : null,
      rightDelta: box ? Math.round(b.right - box.left) : null,
      insideWindow: b.left >= 0 && b.right <= window.innerWidth,
    };
  });

  // 先确认这个几何真的造出了「放不下」，否则下面的断言测的是另一件事。
  expect(m.roomToTheRight).toBeLessThan(m.barWidth);
  // 放不下时它不再左对齐，而是把右边缘落在选区左边缘上。
  expect(m.leftDelta).toBe(-m.barWidth);
  expect(m.rightDelta).toBe(0);
  expect(m.insideWindow).toBe(true);
});
