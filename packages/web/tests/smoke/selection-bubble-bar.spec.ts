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

/**
 * 正文可见区的顶，现场量。
 *
 * 早先这里写死 120（当时实测的值）。同一个文件另外三处都是现场量的，而写死
 * 的那个数一旦顶部 chrome 改高度就不再是被测的那个盒子——队列里的 #129 正是
 * 去掉 document space 顶部横条。设计文档 §11.3 记着同一个数出过的事故：拿一
 * 个实测常量去回答另一个问题，据此得出的结论是错的。
 * @param p - 页面。
 * @returns 正文可见区顶到窗口顶的距离。
 */
async function bodyViewportTop(p: Page): Promise<number> {
  return p.evaluate(() =>
    Math.round(
      document
        .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')!
        .getBoundingClientRect().top,
    ));
}

/** 条跟它锚定那一行之间的间距，跟实现里的 `GAP_FROM_SELECTION_PX` 同一个数。 */
const GAP_FROM_SELECTION_PX = 8;

// 一次登录，全文件共用一个页面。登录限流是 5 次每分钟，而这里有 8 条实跑用例
// （最后那条视觉规格在明暗两套上各跑一遍）——每条各登一次必然从第六条起全部
// 超时在登录页上（实测）。串行加共用页面既避开限流，也避开「同一个账号同时开
// 好几个会话」这种本文件不打算测的东西。
//
// 视口不走 `test.use`：那个配的是 `page` fixture 的选项，而这里没有任何用例取
// 它，页面是 `beforeAll` 自己 `browser.newPage` 建的，尺寸在那儿给。
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

/** 浮出条相对选中那一行的位置，以及它有没有真的被画出来。 */
async function readGeometry(page: Page): Promise<{
  lineTop: number;
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
    const below = !!line && b.top >= line.bottom;
    return {
      lineTop: line ? Math.round(line.top) : 0,
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
  expect(first.lineTop - (await bodyViewportTop(page))).toBeLessThan(44);
  expect(first.below).toBe(true);
  expect(first.gap).toBe(8);
  // 不量「有没有越出裁切盒」：上面已经断言了它在选区下方且间距 8，而选区必在
  // 正文可见区内（顶 120）、裁切盒顶是 80，所以那句话在此恒真、逮不到任何东西。
  // 真正要量的是它有没有被画出来——打在它自己顶上，命中的必须是它自己。
  expect(first.hitAtOwnTop).toBe(true);

  // 中间某段：上方空间充足，照旧在上方。
  await selectParagraph(page, 8);
  const middle = await readGeometry(page);
  expect(middle.lineTop - (await bodyViewportTop(page))).toBeGreaterThan(44);
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
  await scrollBodyTo(page, before.lineTop - (await bodyViewportTop(page)) - 10);

  const m = await readGeometry(page);
  expect(m.lineTop - (await bodyViewportTop(page))).toBeLessThan(44);
  // 第一轮实现在这里把浮出条画到了裁切盒之外，顶上 4px 被削掉（实测条顶 76、
  // 裁切盒顶 80）。现在它该翻到选区下方。
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

test('按过浮出条之后再点到编辑器外面，条要消失', async () => {
  test.setTimeout(120_000);
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox');
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  // 按一下条上的按钮。插件在捕获相给整条挂了 mousedown，按下就把 preventHide
  // 置真（`dist/index.js:78-79` 定义、`:182` 注册），而它全文件唯一的复位在
  // `blurHandler` 的 `:106-108`，那一支返回、不隐藏。
  await page.getByTestId('doc-bubble-tool-bold').click();
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  const stillFocused = await page.evaluate(() => {
    const editor = document.querySelector(
      '[data-testid="document-space"] .ProseMirror',
    );
    return editor?.contains(document.activeElement) ?? false;
  });
  expect(stillFocused).toBe(true);

  // 真的用鼠标点，不是按 Tab。两条路进插件的方式不同：实测点击派发**一次**
  // blur、Tab 派发两次，而那个闩（按条时置真、只在 blurHandler 里复位）按理
  // 会吃掉单独的那一次。实测两条路条都从 DOM 里消失——点击那条走的不是
  // blurHandler，是这一下产生的编辑器事务让插件重问了 `shouldShow`。
  await page.locator('[data-testid="space-tab-bar"], header').first().click();
  await page.waitForTimeout(500);

  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeHidden();
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
    // 量的必须是 flip 量的那个盒子。它的 boundary 是正文可见区，而正文列比它
    // 窄一整条居中外边距（1280 下差 96px，窗口越宽差得越多）——拿正文列去量，
    // 这句前置断言在 1440 下照样成立，而 flip 已经不翻了，下面三句会红在一个
    // 跟被测行为无关的原因上（实测：列内余量恒 59，可见区余量 155 → 235）。
    const viewport = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.getBoundingClientRect();
    return {
      roomToTheRight: box && viewport ? Math.round(viewport.right - box.left) : null,
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

/**
 * 全选：按两次 `Mod-a`。
 *
 * 一次不够——实测第一次只选中光标所在那个块（选到的文字就是那一段），走的还是
 * 「选了一部分」那一档；第二次才是整篇。判据是 `AllSelection`，所以只有第二次
 * 之后才进钉鼠标那一档。
 * @param page - 页面。
 */
async function selectWholeDocument(page: Page): Promise<void> {
  const mod = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
  await page.keyboard.press(mod);
  await page.keyboard.press(mod);
  await page.waitForTimeout(400);
}

/** 浮出条现在在不在屏幕上，以及它在哪。 */
async function readBar(page: Page): Promise<{
  shown: boolean;
  left: number | null;
  top: number | null;
}> {
  return page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement | null;
    // 「不显示」有两种落法，都要算作不显示：插件把元素整个摘出文档
    // （`hide()` 里的 `element.remove()`），或者 `hide` 中间件把它设成
    // `visibility: hidden`。只查 DOM 在不在会把后者读成「显示着」。
    if (!el || !el.isConnected) return { shown: false, left: null, top: null };
    if (getComputedStyle(el).visibility === 'hidden') {
      return { shown: false, left: null, top: null };
    }
    const b = el.getBoundingClientRect();
    return { shown: true, left: Math.round(b.left), top: Math.round(b.top) };
  });
}

// A14。四条走完一条完整的路：全选时鼠标在正文里就摆在鼠标那儿、滚动不动它；
// 鼠标在外面就不摆，滚多远都不摆；鼠标回到正文里，条自己就出来，不用滚。
test('全选时条钉在鼠标那儿，滚动不改变它的屏幕坐标', async () => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  // 把鼠标停在正文里一个确定的点上，全选之后条就该出现在这儿。
  const spot = await page.evaluate(() => {
    const v = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.getBoundingClientRect();
    return { x: Math.round((v?.left ?? 0) + 300), y: Math.round((v?.top ?? 0) + 240) };
  });
  await page.mouse.move(spot.x, spot.y);
  await selectWholeDocument(page);

  const before = await readBar(page);
  expect(before.shown).toBe(true);
  // 条的左边缘就是鼠标那一点，间距做在竖直方向（条底在鼠标上方 8px）。
  expect(before.left).toBe(spot.x);

  await scrollBodyTo(page, 300);
  const after = await readBar(page);
  expect(after.shown).toBe(true);
  expect(after.left).toBe(before.left);
  expect(after.top).toBe(before.top);
});

test('全选时鼠标不在正文里就不显示，鼠标不进来滚多远都不显示', async () => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  // 先让编辑器拿到焦点（点一下正文），再把鼠标挪到窗口左上角——那儿在正文
  // 显示区外面，是顶部横条那一带。
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await page.mouse.move(8, 8);
  await selectWholeDocument(page);

  expect((await readBar(page)).shown).toBe(false);

  // 滚动本身不构成「可以摆出来了」——鼠标还在外面。
  await scrollBodyTo(page, 200);
  expect((await readBar(page)).shown).toBe(false);
  await scrollBodyTo(page, 600);
  expect((await readBar(page)).shown).toBe(false);
});

test('全选后鼠标回到正文里，条自己就出来了——不用滚动', async () => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await page.mouse.move(8, 8);
  await selectWholeDocument(page);
  expect((await readBar(page)).shown).toBe(false);

  // 鼠标从正文外面进到正文里。这一下就是触发时刻——user 2026-08-20 把条件
  // 从「每次滚动」改成「鼠标进入正文」，所以不需要滚，也不需要再按全选。
  const spot = await page.evaluate(() => {
    const v = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.getBoundingClientRect();
    return { x: Math.round((v?.left ?? 0) + 420), y: Math.round((v?.top ?? 0) + 300) };
  });
  await page.mouse.move(spot.x, spot.y);
  await page.waitForTimeout(400);

  const shown = await readBar(page);
  expect(shown.shown).toBe(true);
  // 落在鼠标那一点，不是上一次算出来的位置。唤醒插件要连发两个 meta：`'show'`
  // 自己会先 `updatePosition()` 再 `show()`，而前者在条还没显示时立刻返回，所以
  // 单发一个条会带着旧坐标出现——变异实测：删掉第二个 meta，条落在 616 而不是
  // 鼠标所在的 820，而单测一条都不红（jsdom 里量不到位置）。
  expect(shown.left).toBe(spot.x);

  // 摆出来之后就钉住了：鼠标继续在正文里动、滚动，它都不动。
  await page.mouse.move(spot.x + 200, spot.y + 100);
  await page.waitForTimeout(300);
  expect((await readBar(page)).left).toBe(shown.left);
  await scrollBodyTo(page, 450);
  const again = await readBar(page);
  expect(again.shown).toBe(true);
  expect(again.left).toBe(shown.left);
  expect(again.top).toBe(shown.top);
});

// 定稿 §5.1 的两档对照表给全选那一格写的是「竖直方向夹」。这一档的锚点是一个
// 钉住的点，`hide` 中间件在这一档永远不开火（锚点矩形恒在边界内），所以真正
// 挡着条跑到正文区域上方的只有 `flip`。之前五条 E2E 的钉点全在离上沿 200px
// 以外，这一格从没被量过——而 `isInside` 接受指针正好落在上沿。
test('全选时鼠标贴着正文区域上沿，条也不画到区域外面', async () => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();

  const spot = await page.evaluate(() => {
    const v = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.getBoundingClientRect();
    const top = Math.round(v?.top ?? 0);
    return { x: Math.round((v?.left ?? 0) + 420), y: top + 4, top };
  });
  await page.mouse.move(spot.x, spot.y);
  await selectWholeDocument(page);
  await page.waitForTimeout(400);

  const bar = await readBar(page);
  expect(bar.shown).toBe(true);
  // 锚点上方只剩 4px，条要 44px 加 8px 间距——放不下，`flip` 该把它翻到锚点
  // 下方去，而不是让它压在正文区域上面那条属于顶部横条的带子里。
  expect(bar.top).toBeGreaterThanOrEqual(spot.top);
});

// 规则一的后半句：鼠标位置不知道的时候，全选也不摆条。这条只有真浏览器测得了
// ——「不知道」的唯一来源是指针离开了页面，而那个事件 jsdom 里只能手工派发。
test('鼠标离开浏览器之后，键盘全选不把条摆出来', async () => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();

  // 先在正文里待过，好让「最后一次已知位置」确实落在正文里——不这样的话
  // 断言的就是「从没知道过」，跟这条要测的「知道过又作废」不是一回事。
  const spot = await page.evaluate(() => {
    const v = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.getBoundingClientRect();
    return { x: Math.round((v?.left ?? 0) + 420), y: Math.round((v?.top ?? 0) + 300) };
  });
  await page.mouse.move(spot.x, spot.y);

  // 出页面。视口外的坐标让 Chrome 发一个 relatedTarget 为空的 mouseout。
  await page.mouse.move(spot.x, -20);
  await page.waitForTimeout(200);

  await selectWholeDocument(page);
  await page.waitForTimeout(400);

  expect((await readBar(page)).shown).toBe(false);
});

// 手工走真实用户路径时逮到的：钉住的位置必须跟着「不再是全选」作废。第一版把
// 作废写在取锚点那个函数里，而选区一空，判显示和取锚点两条路都提前返回、滚动
// 那条又被「已经钉住了」挡下——三条路没有一条走得到清理，于是下一次全选时条
// 带着上一次的坐标回来，哪怕鼠标已经在正文外面。
test('全选摆出条之后点掉选区，再在正文外全选，条不许拿旧位置回来', async () => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  const spot = await page.evaluate(() => {
    const v = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.getBoundingClientRect();
    return { x: Math.round((v?.left ?? 0) + 320), y: Math.round((v?.top ?? 0) + 260) };
  });
  await page.mouse.move(spot.x, spot.y);
  await selectWholeDocument(page);
  const pinned = await readBar(page);
  expect(pinned.shown).toBe(true);
  expect(pinned.left).toBe(spot.x);

  // 点掉选区，条跟着走。
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  expect((await readBar(page)).shown).toBe(false);

  // 鼠标到正文外面，再全选：手里没有区域内的坐标，就不该显示——尤其不该显示
  // 在上一次那个位置上。
  await page.mouse.move(8, 8);
  await selectWholeDocument(page);
  expect((await readBar(page)).shown).toBe(false);
});

// 窗口尺寸变了，两档的条都跟着动、都还在正文里。从用户角度这两档在这件事上
// 没有区别（user 2026-08-20）：「位置不动」那条规则只约束滚动。
test('窗口缩小时，两档的条都跟着动并留在正文区域内', async () => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  /** 条的位置、正文区域，以及条在不在区域里。 */
  const geo = async (): Promise<{
    shown: boolean;
    barLeft: number;
    barRight: number;
    viewLeft: number;
    viewRight: number;
    inside: boolean;
  }> =>
    page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="doc-selection-bubble-bar"]',
      ) as HTMLElement;
      const b = el.getBoundingClientRect();
      const v = document
        .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')!
        .getBoundingClientRect();
      return {
        shown: el.isConnected && getComputedStyle(el).visibility !== 'hidden',
        barLeft: Math.round(b.left),
        barRight: Math.round(b.right),
        viewLeft: Math.round(v.left),
        viewRight: Math.round(v.right),
        inside: b.left >= v.left && b.right <= v.right,
      };
    });

  // 选了一部分：锚点每次现场量，条自然跟着重排后的选区走。
  await selectParagraph(page, 6);
  const partialWide = await geo();
  expect(partialWide.inside).toBe(true);
  await page.setViewportSize({ width: 1000, height: 950 });
  await page.waitForTimeout(700);
  const partialNarrow = await geo();
  expect(partialNarrow.shown).toBe(true);
  expect(partialNarrow.inside).toBe(true);
  expect(partialNarrow.barLeft).not.toBe(partialWide.barLeft);

  // 全选：钉住的坐标按正文区域的新旧尺寸等比例重算。条既不消失，也不停在
  // 一个已经在区域外面的位置上。
  await page.setViewportSize({ width: 1680, height: 950 });
  await page.waitForTimeout(600);
  const far = await page.evaluate(() => {
    const v = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')!
      .getBoundingClientRect();
    return { x: Math.round(v.right) - 40, y: Math.round(v.top) + 300 };
  });
  await page.mouse.move(far.x, far.y);
  await selectWholeDocument(page);
  const allWide = await geo();
  expect(allWide.shown).toBe(true);
  expect(allWide.inside).toBe(true);

  await page.setViewportSize({ width: 1000, height: 950 });
  await page.waitForTimeout(700);
  const allNarrow = await geo();
  expect(allNarrow.shown).toBe(true);
  expect(allNarrow.inside).toBe(true);
  // 相对位置守恒：钉住的点在区域宽度里占的比例，缩窄前后一致（差 ≤2px）。
  const ratioWide =
    (allWide.barRight - allWide.viewLeft) / (allWide.viewRight - allWide.viewLeft);
  const ratioNarrow =
    (allNarrow.barRight - allNarrow.viewLeft)
    / (allNarrow.viewRight - allNarrow.viewLeft);
  expect(Math.abs(ratioNarrow - ratioWide)).toBeLessThan(0.01);
});

// A15。逐像素扫描：锚定那一行跟正文可见区不相交的每一个滚动位置上，条都不能
// 在屏幕上。不能只断言「它被裁掉了」——条挂在滚动容器外面，裁它的那一层比正文
// 可见区高 40px，只靠裁切它会在那条 40px 的带子里露出来，画在顶部横条上。
test('选了一部分时，锚定那一行滚出正文显示区，条就不显示', async () => {
  test.setTimeout(240_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);
  await selectParagraph(page, 6);

  const start = await readGeometry(page);
  const bad: { scroll: number; barTop: number | null; lineTop: number }[] = [];
  const stray: { scroll: number; barTop: number; viewTop: number }[] = [];
  // 从「那一行还在屏上」一路滚到「它早已滚过去」，每 6px 量一次。
  for (let y = 0; y <= start.lineTop + 240; y += 6) {
    await page.evaluate((top) => {
      document
        .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
        ?.scrollTo(0, top);
    }, y);
    // 滚动重算没有防抖，一帧足够。
    await page.waitForTimeout(30);
    const m = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="doc-selection-bubble-bar"]',
      ) as HTMLElement | null;
      const shown = !!el && el.isConnected
        && getComputedStyle(el).visibility !== 'hidden';
      const box = window.getSelection()?.rangeCount
        ? window.getSelection()!.getRangeAt(0).getBoundingClientRect()
        : null;
      const v = document
        .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
        ?.getBoundingClientRect();
      return {
        shown,
        barTop: el ? Math.round(el.getBoundingClientRect().top) : null,
        // 锚定的是 head 那一行，看不见才退到 from 那一行。这里选区是一整段，
        // 两端在同一段里，段落的包围盒够用。
        lineTop: box ? Math.round(box.top) : 0,
        lineBottom: box ? Math.round(box.bottom) : 0,
        viewTop: v ? Math.round(v.top) : 0,
        viewBottom: v ? Math.round(v.bottom) : 0,
      };
    });
    // 判的是喂给 `hide` 中间件的那个锚点矩形，也就是那一行上下各撑一个间距
    // ——间距是锚点的一部分（做进锚点是为了让 `flip` 看到条真实需要的空间），
    // 所以行盒本身刚离开可见区时锚点矩形还差 8px 才算完全离开。拿没撑过的行盒
    // 去判会比实现严 8px：实测在 6px 的扫描步长下落进两个采样点（滚动位置 276
    // 和 282），而那两处条顶分别是 127 和 121，都在可见区（顶 120）里面。
    const anchorTop = m.lineTop - GAP_FROM_SELECTION_PX;
    const anchorBottom = m.lineBottom + GAP_FROM_SELECTION_PX;
    const overlaps = anchorBottom > m.viewTop && anchorTop < m.viewBottom;
    if (!overlaps && m.shown) {
      bad.push({ scroll: y, barTop: m.barTop, lineTop: m.lineTop });
    }
    // A15 真正要防的后果，单独量一次：条挂在滚动容器外面，裁它的那一层比正文
    // 可见区高 40px，所以只靠裁切它会在那条带子里露出来、画在顶部横条上。
    if (m.shown && m.barTop !== null && m.barTop < m.viewTop) {
      stray.push({ scroll: y, barTop: m.barTop, viewTop: m.viewTop });
    }
  }

  expect(bad).toEqual([]);
  expect(stray).toEqual([]);
});

// A16。左右都不许伸出正文显示区，两档各量一次。
test('条的左右不伸出正文显示区——选了一部分和全选各量一次', async () => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshDocument(page);
  await page.keyboard.type(
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi '
    + 'omicron pi rho sigma tau upsilon phi chi psi omega and more words after',
  );

  /** 条的左右边缘跟正文可见区左右边缘的关系。 */
  const edges = async (): Promise<{
    barLeft: number;
    barRight: number;
    viewLeft: number;
    viewRight: number;
  }> =>
    page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="doc-selection-bubble-bar"]',
      ) as HTMLElement;
      const b = el.getBoundingClientRect();
      const v = document
        .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')!
        .getBoundingClientRect();
      return {
        barLeft: Math.round(b.left),
        barRight: Math.round(b.right),
        viewLeft: Math.round(v.left),
        viewRight: Math.round(v.right),
      };
    });

  // 选了一部分：选区必须真的做到正文列最右端，否则条离右边界还有几百像素，
  // 两条断言恒真、`shift` 的 boundary 删掉都不会红（第八轮对抗查实）。
  // 双击第一行最靠右的那个词，做法跟同文件那条水平翻转用例一致。
  //
  // 正文列是居中的，它的右端离正文可见区的右边还隔着一整条外边距——1680 宽下
  // 实测余量 155px。这个余量本身就是设计（正文不贴边），所以前置断言按它的实
  // 际量级定：条确实被推到了列的右端，而不是停在列中间。
  const spot = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="document-space"] .ProseMirror p');
    const text = p?.firstChild as Text;
    const range = document.createRange();
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
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible({ timeout: 5_000 });
  const partial = await edges();
  // 先确认这个几何真的把条推到了右边界附近，否则下面两句测的是别的东西。
  expect(partial.viewRight - partial.barRight).toBeLessThan(200);
  expect(partial.barRight).toBeLessThanOrEqual(partial.viewRight);
  expect(partial.barLeft).toBeGreaterThanOrEqual(partial.viewLeft);

  // 全选：鼠标停在正文可见区右边缘往里 2px，条整个得被推回区域内。
  const rightEdge = await page.evaluate(() => {
    const v = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')!
      .getBoundingClientRect();
    return { x: Math.round(v.right) - 2, y: Math.round(v.top) + 200 };
  });
  await page.mouse.move(rightEdge.x, rightEdge.y);
  await selectWholeDocument(page);
  const all = await edges();
  expect(all.barRight).toBeLessThanOrEqual(all.viewRight);
  expect(all.barLeft).toBeGreaterThanOrEqual(all.viewLeft);
});
