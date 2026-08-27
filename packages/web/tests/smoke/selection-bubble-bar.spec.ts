// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { test, expect, type Locator, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

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

/**
 * How long a `Button` takes to change colour under the pointer.
 *
 * Its base class carries `transition-colors` (`components/ui/button.tsx:19`),
 * which Tailwind gives 150ms. Any assertion about the background a pointer
 * produced has to outlast that, or it reads the value from before the
 * transition started.
 */
const HOVER_TRANSITION_MS = 150;

// 一次登录，全文件共用一个页面。登录限流是 5 次每分钟，而这里有 17 个 test
// 声明、跑出来 18 条（视觉规格那条在明暗两套上各跑一遍）——每条各登一次必然
// 从第六条起全部超时在登录页上（实测）。串行加共用页面既避开限流，也避开
// 「同一个账号同时开好几个会话」这种本文件不打算测的东西。
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

// 每条用例各建一个 Space（各自要一份干净正文），跑完就把它删掉——18 条留 18 个
// 在同一个 project 里，而档位对 Space 数量有上限（`config/membership.yaml`）。
const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

/** 进到一个新建的 Document Space，光标已在正文里。 */
async function openFreshDocument(page: Page): Promise<void> {
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });

  createdSpaceIds.push(
    await createSpace(page, 'document', `bubble-${Date.now()}`),
  );

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
      // #912 的 A 档给了四个数：按钮 28×28 · 图标 16 · 间距 2 · 整条 38 高。
      // 按钮那个下面的 `buttons` 已经在量，其余三个在这里取。
      const barHeight = Math.round(b.height);
      const controlGap = cs.gap;
      /**
       * 一个元素的尺寸，四舍五入成 `宽×高`。
       * @param n - 要量的元素。
       * @returns 那个字符串。
       */
      const size = (n: Element): string => {
        const r = n.getBoundingClientRect();
        return `${Math.round(r.width)}×${Math.round(r.height)}`;
      };
      // 条上每一个 svg，按尺寸归类。四个下拉各带一个箭头，而颜色那格画的是
      // 字母 A 加箭头、没有图标——所以「每格第一个 svg」抓不准，得整片抓完
      // 再按尺寸分。
      const svgs = Array.from(el.querySelectorAll('svg')).map(size);
      const icons = svgs.filter((v) => v === '16×16');
      const chevrons = svgs.filter((v) => v === '13×13');
      // AI 那格的箭头单独量一次，免得它跟着别的一起被改掉没人发现。
      const aiChevron = size(
        [
          ...(el
            .querySelector('[data-testid="doc-bubble-ai"]')
            ?.querySelectorAll('svg') ?? []),
        ].pop() as Element,
      );
      const buttons = Array.from(
        el.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
      ).map((n) => {
        const r = n.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height) };
      });
      // #902 A5 / A6：分组之间那条线。jsdom 答得出它在不在，答不出它多宽多高
      // ——那几个值是 Tailwind 类算出来的，只有真引擎知道。
      const separators = Array.from(
        el.querySelectorAll('[data-testid^="doc-bubble-sep-"]'),
      ).map((n) => {
        const r = n.getBoundingClientRect();
        const scs = getComputedStyle(n);
        return {
          width: Math.round(r.width),
          height: Math.round(r.height),
          marginLeft: scs.marginLeft,
          marginRight: scs.marginRight,
          background: scs.backgroundColor,
          tokenBorder: getComputedStyle(document.documentElement)
            .getPropertyValue('--color-border')
            .trim(),
        };
      });
      // #902 A10：两个未开放的入口，变暗且光标说得出自己不能用。
      /**
       * 一个控件的尺寸和它「能不能用」那几样的计算值。
       * @param testid - 它的 test id。
       * @returns 量出来的那几个数。
       */
      const control = (testid: string): {
        width: number;
        height: number;
        opacity: string;
        cursor: string;
        ariaDisabled: string | null;
      } | null => {
        const n = el.querySelector(`[data-testid="${testid}"]`);
        if (!n) return null;
        const ccs = getComputedStyle(n);
        const r = n.getBoundingClientRect();
        return {
          width: Math.round(r.width),
          height: Math.round(r.height),
          opacity: ccs.opacity,
          cursor: ccs.cursor,
          ariaDisabled: n.getAttribute('aria-disabled'),
        };
      };
      const comment = control('doc-bubble-coming-comment');
      const ai = control('doc-bubble-ai');
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
        chevrons,
        separators,
        comment,
        ai,
        barHeight,
        controlGap,
        icons,
        aiChevron,
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
    // demo 的 `.bubble-btn`（`2026-08-21-editor-command-surface.html`）是 28 高、
    // 28 宽。六个：粗体 斜体 删除线 下划线 行内代码 链接。三个块命令 2026-08-26
    // 起住在块类型菜单里。
    expect(geo.buttons).toHaveLength(6);
    for (const b of geo.buttons) {
      expect(b).toEqual({ width: 28, height: 28 });
    }
    // #912 的另外三个数。整条外高是按钮 28 加上下内距各 4 加边框各 1。
    expect(geo.barHeight).toBe(38);
    expect(geo.controlGap).toBe('2px');
    // 16px 的图标十个：六个命令、块类型、对齐、AI、评论。颜色那格画的是字母
    // A，没有图标。
    expect(geo.icons).toHaveLength(10);
    // 13px 的箭头四个，四个下拉各一个。
    expect(geo.chevrons).toHaveLength(4);
    expect(geo.aiChevron).toBe('13×13');
    // #902 A5 / A6：demo 的 `.bubble-sep`（`2026-08-21-editor-command-surface.html`）
    // 是 1px 宽、16px 高、左右各 3px，颜色走 `--color-border`。
    // 四条，五组之间各一条（demo:521）：块类型 ｜ 对齐 ｜ 粗体 斜体 删除线
    // 下划线 ｜ 链接 行内代码 颜色 评论 ｜ AI。
    expect(geo.separators).toHaveLength(4);
    for (const sep of geo.separators) {
      expect(sep.width).toBe(1);
      expect(sep.height).toBe(16);
      expect(sep.marginLeft).toBe('3px');
      expect(sep.marginRight).toBe('3px');
      expect(sep.background).toBe(sep.tokenBorder);
    }
    // 评论那一个照 `ComingTool` 的既有表示画：图标按钮（`.bubble-btn`，28 宽），
    // 变暗、不可点，看得出它的功能还没做（#18）。
    expect(geo.comment).toMatchObject({
      width: 28,
      height: 28,
      opacity: '0.5',
      cursor: 'not-allowed',
      ariaDisabled: 'true',
    });
    // AI 那格是普通控件：hover 就展开菜单，菜单里每一项照 demo 画，按下去在
    // 控制台留一行（user 2026-08-26）。demo 给它的是带文字和箭头的下拉样子
    // （`.bubble-drop`，宽度跟着文字走）。
    expect(geo.ai).toMatchObject({ height: 28, opacity: '1', ariaDisabled: null });
    expect(geo.ai!.width).toBeGreaterThan(28);
    // G2：挂在滚动容器里面、最上层可见、没跑出窗口。
    expect(geo.insideScroller).toBe(true);
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

  // 首段：它上方到正文可见区顶只有约 30px，而浮出条要 38 高加 8 间距。
  await selectParagraph(page, 0);
  const first = await readGeometry(page);
  expect(first.lineTop - (await bodyViewportTop(page))).toBeLessThan(46);
  expect(first.below).toBe(true);
  expect(first.gap).toBe(8);
  // 不量「有没有越出裁切盒」：上面已经断言了它在选区下方且间距 8，而选区必在
  // 正文可见区内（顶 120）、裁切盒顶是 80，所以那句话在此恒真、逮不到任何东西。
  // 真正要量的是它有没有被画出来——打在它自己顶上，命中的必须是它自己。
  expect(first.hitAtOwnTop).toBe(true);

  // 中间某段：上方空间充足，照旧在上方。
  await selectParagraph(page, 8);
  const middle = await readGeometry(page);
  expect(middle.lineTop - (await bodyViewportTop(page))).toBeGreaterThan(46);
  expect(middle.below).toBe(false);
  expect(middle.gap).toBe(8);

  expect(middle.hitAtOwnTop).toBe(true);
});

test('keeps the side it came up on as its line scrolls to the top (E3)', async () => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);
  await selectParagraph(page, 6);

  // It comes up above the selection: this paragraph has room over it.
  const before = await readGeometry(page);
  expect(before.below).toBe(false);

  // Scroll until that line rests 10px below the top of the visible body, so
  // there is no longer room for the bar's 46 above it. The distance is
  // measured rather than written down: a fixed number drifts with the font
  // size and the line height, and drifting as far as "the paragraph leaves the
  // view" would make this test about something else entirely.
  await scrollBodyTo(page, before.lineTop - (await bodyViewportTop(page)) - 10);

  const after = await readGeometry(page);
  expect(after.lineTop - (await bodyViewportTop(page))).toBeLessThan(46);
  // Which side was settled when the bar came up and holds for as long as it
  // stays up (user 2026-08-26). It travels with its line and the scroller's
  // overflow clips whatever no longer fits, the way the link panel does.
  expect(after.below).toBe(false);
  expect(after.gap).toBe(8);
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

// #902 A10：图标按钮上没有地方摆「未开放」那个徽章，所以理由挂在 tooltip 和
// 可访问名上。jsdom 打不开 Radix 的 tooltip（它走 pointer 事件），只有真引擎
// 答得了这一条。
//
// 只悬停一个入口：两个走的是同一个 `ComingTool`，差别只在传进去的 props，而
// 连着悬停两个会撞上换 trigger 那一刻的中间态——新的已经开了、旧的还在关闭动
// 画里，两个 `[role=tooltip]` 同时挂在 DOM 上。那个中间态跟这条要验的事无关。
test('未开放的入口悬停时说得出自己为什么不能用', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox');
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  const entry = page.getByTestId('doc-bubble-coming-comment');
  const box = (await entry.boundingBox())!;
  // 分步移动，不用 `.hover()`：后者是瞬移，Radix 靠 pointer 事件判断指针到了
  // 哪儿，一个 pointermove 都收不到时它不开。真人的鼠标是连着走的。
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 12,
  });

  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible({ timeout: 5_000 });
  expect(await tip.textContent()).toBe(await entry.getAttribute('aria-label'));

  // 指针就停在入口上，顺带验它没有亮起来。ghost 变体自带的悬停高亮被两个
  // `hover:` 类关掉了，而那两个类只有真引擎跑得出效果——jsdom 不套 CSS。
  //
  // Both assertions here have to outlast {@link HOVER_TRANSITION_MS}: a
  // computed background only leaves its starting value once a frame has
  // rendered, and `DEBUG=pw:api` measured 4 to 6 milliseconds between a
  // pointer move returning and the style being read — inside one frame, which
  // reads the colour from before the hover. This case went red four times in
  // five before the wait (measured 2026-08-24; it does the same on main).
  //
  // The positive assertion below polls for the settled colour. This one can
  // only wait: it expects the background NOT to change, and a transition that
  // never happens fires no `transitionend` and offers nothing to poll for.
  await page.waitForTimeout(HOVER_TRANSITION_MS * 2);
  expect(
    await entry.evaluate((n) => getComputedStyle(n).backgroundColor),
  ).toBe('rgba(0, 0, 0, 0)');
  const lit = page.getByTestId('doc-bubble-tool-bold');
  const litBox = (await lit.boundingBox())!;
  await page.mouse.move(litBox.x + litBox.width / 2, litBox.y + litBox.height / 2, {
    steps: 12,
  });
  // 对照：同一条上能按的按钮，同样的指针动作下底色确实变了。没有这一半，上面
  // 那条断言对一个根本没收到悬停的元素也成立。
  await expect
    .poll(() => lit.evaluate((n) => getComputedStyle(n).backgroundColor), {
      timeout: 5_000,
    })
    .not.toBe('rgba(0, 0, 0, 0)');

  // 按下去什么都不该发生。`aria-disabled` 不拦点击——那正是它跟 HTML
  // `disabled` 的区别：入口留在可访问性树里，读得出来，也点得到。它什么都不做
  // 是因为身上没挂任何处理器；这条断言守的就是这一点，等后面的切片给它接上真
  // 功能时它会红，那时候正该红。
  const html = (): Promise<string> =>
    page.evaluate(
      () =>
        document.querySelector('[data-testid="document-space"] .ProseMirror')
          ?.innerHTML ?? '',
    );
  //
  // `force` 是必须的：playwright 把 `aria-disabled` 读成「未启用」，它自己的
  // 可操作性检查会一直等下去。真人的鼠标不走那道检查。
  const before = await html();
  await entry.click({ force: true });
  await page.getByTestId('doc-bubble-ai').click({ force: true });
  expect(await html()).toBe(before);

  // 这套用例共享同一个 page，而后面几条的前提是「鼠标不在正文里」。上面的悬停
  // 会把指针留在条上，所以离开时把它放回正文外，跟这条开始时一样。
  await page.mouse.move(8, 8);
});

/**
 * Walk the pointer onto one opener and wait for its menu.
 *
 * Step-wise, the way the case above does it: `.hover()` teleports, and Radix
 * decides from pointer events, so a jump delivers none and the menu never
 * opens.
 * @param slot - The opener's test id.
 * @returns The menu element's locator.
 */
async function hoverOpenSlot(slot: string): Promise<Locator> {
  const opener = page.getByTestId(slot);
  const box = (await opener.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 12,
  });
  const menu = page.getByTestId(`${slot}-menu`);
  await expect(menu).toBeVisible({ timeout: 5_000 });
  return menu;
}

// B1 and A5/A6 in a real browser. Every hover menu on the bar had been opened
// only in jsdom, where no stylesheet loads and Radix's own pointer handling
// runs against a layout that does not exist — so what a reader sees on
// hovering one of these four had never been measured.
test('每个下拉都能悬停打开，内容照 demo，点一项只写控制台', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox jumps');
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  const rowsOf = async (menu: Locator): Promise<string[]> =>
    menu.evaluate((el) =>
      [...el.querySelectorAll('[role="menuitem"]')].map((r) =>
        (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));

  const blockType = await hoverOpenSlot('doc-bubble-block-type');
  expect(await rowsOf(blockType)).toHaveLength(9);
  expect(
    await blockType.locator('[data-testid^="doc-bubble-block-type-shortcut-"]').count(),
  ).toBe(7);

  const align = await hoverOpenSlot('doc-bubble-align');
  expect(await rowsOf(align)).toHaveLength(3);

  const colour = await hoverOpenSlot('doc-bubble-color');
  // Two rows of eight and a reset, and the cell's own measurements: 30 square
  // with the letter at 15px (demo:241-247).
  expect(await colour.locator('[data-testid^="doc-bubble-color-text-"]').count()).toBe(8);
  expect(await colour.locator('[data-testid^="doc-bubble-color-fill-"]').count()).toBe(8);
  await expect(colour.getByTestId('doc-bubble-color-reset')).toBeVisible();
  // The computed box rather than the painted one: the bar is placed by a
  // `transform` whose offsets carry a fraction, so every rect under it lands
  // on a fraction too and rounds to 29 or 30 depending on where the bar sits.
  const cell = await colour.getByTestId('doc-bubble-color-text-red').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { w: cs.width, h: cs.height, fontSize: cs.fontSize, box: cs.boxSizing };
  });
  expect(cell).toMatchObject({
    w: '30px',
    h: '30px',
    fontSize: '15px',
    box: 'border-box',
  });

  // Set up before the menu opens. A menu closes once the pointer has been off
  // it for its grace period, so anything done between opening and pressing is
  // time the menu spends on its way out.
  const lines: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') lines.push(m.text());
  });
  const bodyBefore = await page.evaluate(
    () =>
      document.querySelector('[data-testid="document-space"] .ProseMirror')
        ?.innerHTML ?? '',
  );

  const ai = await hoverOpenSlot('doc-bubble-ai');
  expect(await rowsOf(ai)).toHaveLength(8);

  // Pressing a row that reaches no command: the console carries it, the
  // document is untouched, and the menu goes away like any other.
  //
  // The pointer walks onto the row and presses there. `click()` teleports and
  // holds the press until the element reports itself stable, and a menu that
  // opens with a transition is not stable for a frame or two — long enough for
  // the pointer, still parked on the opener, to be treated as having left.
  const row = ai.getByTestId('doc-bubble-ai-item-refine');
  const rowBox = (await row.boundingBox())!;
  await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2, {
    steps: 10,
  });
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId('doc-bubble-ai-menu')).toBeHidden({ timeout: 5_000 });
  expect(lines.filter((l) => l.includes('not implemented yet'))).toHaveLength(1);
  expect(
    await page.evaluate(
      () =>
        document.querySelector('[data-testid="document-space"] .ProseMirror')
          ?.innerHTML ?? '',
    ),
  ).toBe(bodyBefore);

  // The pointer goes back outside the body, the way the cases here leave it.
  await page.mouse.move(8, 8);
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
  // 先看再点，不赌坐标。原先这里点的是 Space tab 条的中心，前提是那儿一片
  // 空白；tab 攒到几百个之后那个位置上是一个 tab，点下去切换的是 Space，
  // 编辑器根本没失焦（2026-08-23 实测 451 个 tab，命中 `space-tab-name-…`）。
  // 现在由测试自己扫出一个落点：编辑器外面、且那一点最上层的东西不接受点击。
  const spot = await page.evaluate(() => {
    const isInert = (el: Element | null): boolean =>
      !!el &&
      !el.closest(
        'a, button, input, textarea, select, [role="button"], [role="tab"], [data-testid="document-space"]',
      );
    for (let y = 8; y < 40; y += 8) {
      for (let x = 400; x < 1600; x += 40) {
        if (isInert(document.elementFromPoint(x, y))) return { x, y };
      }
    }
    return null;
  });
  expect(
    spot,
    'no inert spot outside the editor to click — the page layout changed',
  ).not.toBeNull();
  await page.mouse.click(spot!.x, spot!.y);
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
    // 窄一整条居中外边距，窗口越宽差得越多——拿正文列去量，会在某些宽度下
    // 得出「放得下」而 flip 已经不翻了，下面三句就红在一个跟被测行为无关的
    // 原因上。
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
  // 放不下时它不再左对齐，而是把右边缘落在选区左边缘上。左边缘的位置由这两
  // 个各自 `Math.round` 过的数相减得来，所以容许 1px：和的舍入跟两个舍入的和
  // 差得出 1。对齐这件事本身由下一句量，那里只有一次舍入。
  expect(Math.abs((m.leftDelta ?? NaN) + m.barWidth)).toBeLessThanOrEqual(1);
  // 取绝对值：这个差值由两次 `Math.round` 相减得来，落在零上时可能是 `-0`，
  // 而 `toBe` 走 `Object.is`，`-0` 跟 `0` 在那儿不相等。
  expect(Math.abs(m.rightDelta ?? NaN)).toBe(0);
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

// A14 的头三条，走完一条完整的路：全选时鼠标在正文里就摆在鼠标那儿、滚动不动
// 它；鼠标在外面就不摆，滚多远都不摆；鼠标回到正文里，条自己就出来，不用滚。
// A14 还有三条在下面，各带自己的分组说明：贴着上沿、鼠标离开浏览器、窗口缩小。
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

// 定稿 §5.1 的两档对照表给全选那一格写的是「竖直方向夹」。这一档实际挡着条
// 跑到正文区域上方的只有 `flip`：`hide` 判的不是「锚点在不在边界内」，而是
// 「有没有哪一边被完全裁掉」（`@floating-ui/core` 的 `isAnySideFullyClipped`，
// 溢出量要 ≥ 锚点自身的宽高）。钉住的点被 `anchorRect` 上下各撑 8，指针又必
// 在区域内，所以顶部最多溢出 8、而锚点高 16——判不出裁掉。之前五条 E2E 的
// 钉点全在离上沿 200px 以外，这一格从没被量过。
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
  // 锚点上方只剩 4px，而条要 38px（按钮 28 + 上下内距各 4 + 边框各 1）再加
  // 8px 间距——放不下，`flip` 该把它翻到锚点下方去，而不是让它压在正文区域
  // 上面那条属于顶部横条的带子里。
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
        // 1px 容差：`shift` 把条推到边界上时两条边重合，而这是浮点数，
        // 差出来的零点几像素画不出来。量到过 `barRight` 和 `viewRight`
        // 舍入后都是 1680，精确比较仍判 false。
        inside: b.left >= v.left - 1 && b.right <= v.right + 1,
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
  const pin = await page.evaluate(() => {
    const v = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')!
      .getBoundingClientRect();
    // A quarter of the way in. The bar is about 421 wide and fits to the right
    // of that point at both widths, so `shift` leaves it where the anchor puts
    // it and `barLeft` below reads the pin itself.
    return { x: Math.round(v.left + v.width * 0.25), y: Math.round(v.top) + 300 };
  });
  await page.mouse.move(pin.x, pin.y);
  await selectWholeDocument(page);
  const allWide = await geo();
  expect(allWide.shown).toBe(true);
  expect(allWide.inside).toBe(true);

  await page.setViewportSize({ width: 1000, height: 950 });
  await page.waitForTimeout(700);
  const allNarrow = await geo();
  expect(allNarrow.shown).toBe(true);
  expect(allNarrow.inside).toBe(true);
  // The bar's left edge is the pinned point: `top-start` against a zero-width
  // anchor puts the floating x on the reference's own left edge, and nothing
  // moves it from there while it fits. This is what makes the two ratios below
  // measure the pin rather than a boundary — a bar pushed onto the body's edge
  // reads that edge at both widths, and the comparison would hold whatever the
  // pin did. 1px of tolerance for the rounding on either side.
  expect(Math.abs(allWide.barLeft - pin.x)).toBeLessThanOrEqual(1);
  // The point is remapped, so it lands somewhere else on screen.
  expect(allNarrow.barLeft).not.toBe(allWide.barLeft);
  // Its share of the body's width is what survives the resize. The tolerance is
  // 0.01 of the ratio: about 7px over the narrow body's ~680, about 14px over
  // the wide one's ~1360.
  const ratioWide =
    (allWide.barLeft - allWide.viewLeft) / (allWide.viewRight - allWide.viewLeft);
  const ratioNarrow =
    (allNarrow.barLeft - allNarrow.viewLeft)
    / (allNarrow.viewRight - allNarrow.viewLeft);
  expect(Math.abs(ratioNarrow - ratioWide)).toBeLessThan(0.01);
});

// E5, both halves. The bar travels with its line and the scroller's overflow
// clips it: measured every 6px on the way out, the bar is on screen only while
// its anchor is, and scrolling back brings it into view again. The reverse half
// is the one that used to go unmeasured — a bar that never came back would have
// passed.
test('the bar leaves view with its line, and comes back with it', async () => {
  test.setTimeout(240_000);
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);
  await selectParagraph(page, 6);

  const bad: { scroll: number; barTop: number | null; lineTop: number }[] = [];
  /**
   * Where the bar and its line sit against the body's visible area.
   * @returns The three boxes, rounded.
   */
  const measure = async (): Promise<{
    barTop: number | null;
    barBottom: number | null;
    lineTop: number;
    lineBottom: number;
    viewTop: number;
    viewBottom: number;
  }> => page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement | null;
    const bar = el?.getBoundingClientRect();
    const box = window.getSelection()?.rangeCount
      ? window.getSelection()!.getRangeAt(0).getBoundingClientRect()
      : null;
    const v = document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.getBoundingClientRect();
    return {
      barTop: bar ? Math.round(bar.top) : null,
      barBottom: bar ? Math.round(bar.bottom) : null,
      lineTop: box ? Math.round(box.top) : 0,
      lineBottom: box ? Math.round(box.bottom) : 0,
      viewTop: v ? Math.round(v.top) : 0,
      viewBottom: v ? Math.round(v.bottom) : 0,
    };
  });

  const start = await measure();

  // Out: from "the line is still on screen" to well past it, 6px at a time.
  for (let y = 0; y <= start.lineTop + 240; y += 6) {
    await scrollBodyTo(page, y);
    // Repositioning on scroll is not debounced; one frame is enough.
    await page.waitForTimeout(30);
    const m = await measure();
    // The anchor is the line grown by one gap either side, which is what the
    // bar is placed against.
    const anchorTop = m.lineTop - GAP_FROM_SELECTION_PX;
    const anchorBottom = m.lineBottom + GAP_FROM_SELECTION_PX;
    const anchorInView = anchorBottom > m.viewTop && anchorTop < m.viewBottom;
    const barInView =
      m.barTop !== null
      && m.barBottom !== null
      && m.barBottom > m.viewTop
      && m.barTop < m.viewBottom;
    if (!anchorInView && barInView) {
      bad.push({ scroll: y, barTop: m.barTop, lineTop: m.lineTop });
    }
  }
  expect(bad).toEqual([]);

  // Back: the same selection, the same place, and the bar is visible again.
  await scrollBodyTo(page, 0);
  await page.waitForTimeout(60);
  const back = await measure();
  expect(back.barTop).not.toBeNull();
  expect(back.barBottom!).toBeGreaterThan(back.viewTop);
  expect(back.barTop!).toBeLessThan(back.viewBottom);
  // Where it was before any of this scrolling.
  expect(Math.abs(back.barTop! - start.barTop)).toBeLessThanOrEqual(1);
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
  // 正文列是居中的，它的右端离正文可见区的右边还隔着一整条外边距，而那条
  // 外边距随窗口宽度变（正文列有最大宽度，窗口越宽外边距越大）。所以下面的
  // 前置断言按「条被推到了列的右端、不是停在列中间」来写，不钉某个具体像素
  // 数——那个数只在量它的那个视口下成立。
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

/** Put a link on whatever is selected, through the panel the user would use. */
async function linkTheSelection(page: Page, url: string): Promise<void> {
  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('doc-link-input').fill(url);
  await page.getByTestId('doc-link-confirm').click();
}

/**
 * Reach the `view` state over the body's first link, the way a reader does.
 *
 * The selection left over from making the link is collapsed first, and the
 * press lands on the link's own first line: the bar hangs over the middle of a
 * link that runs to two lines and swallows a press aimed at the element's box.
 */
async function openViewOverFirstLink(page: Page): Promise<void> {
  const bar = page.getByTestId('doc-selection-bubble-bar');
  if (await bar.isVisible()) {
    // Confirming an address closes the panel and hands focus back to the body,
    // and the hand-back is a frame behind the close. A keypress sent before it
    // lands goes nowhere and leaves the selection — and the bar — as they were.
    await expect(page.getByTestId('doc-link-popover')).toBeHidden({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="document-space"] .ProseMirror'),
    ).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(bar).not.toBeAttached({ timeout: 5_000 });
  }

  const spot = await page.evaluate(() => {
    const line = document.querySelector('.ProseMirror a')!.getClientRects()[0]!;
    return {
      x: Math.round(line.left + line.width / 2),
      y: Math.round(line.top + line.height / 2),
    };
  });
  await page.mouse.click(spot.x, spot.y);

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-url')).toBeVisible({ timeout: 5_000 });
}

/** The panel against a rectangle: how far its centre is off, and the gap above it. */
async function panelAgainst(
  page: Page,
  rect: { left: number; right: number; bottom: number },
): Promise<{ centreOffset: number; gapBelow: number }> {
  return page.evaluate((target) => {
    const panel = document
      .querySelector('[data-testid="doc-link-popover"]')!
      .getBoundingClientRect();
    return {
      centreOffset:
        (panel.left + panel.right) / 2 - (target.left + target.right) / 2,
      gapBelow: panel.top - target.bottom,
    };
  }, rect);
}

/**
 * Wait until the panel is placed 8px under `rect`, and report where it landed.
 *
 * The panel counts as visible from the frame it mounts on and is placed on a
 * later one, so the gap is polled rather than read once. It is allowed a pixel
 * either side of the 8 `offset(8)` asks for: floating-ui snaps its translate to
 * whole device pixels (`roundByDPR` in `@floating-ui/react-dom`), and a target
 * whose bottom edge falls on a half pixel — a wrapped line does, measured at
 * 154.5 — comes out 8.5.
 */
async function settlePanelUnder(
  page: Page,
  rect: { left: number; right: number; bottom: number },
): Promise<{ centreOffset: number; gapBelow: number }> {
  await expect
    .poll(async () => Math.abs((await panelAgainst(page, rect)).gapBelow - 8))
    .toBeLessThanOrEqual(1);
  return panelAgainst(page, rect);
}

/**
 * The panel is under `rect` and inside the body column.
 *
 * At a narrow width, centring the panel on a short target would hang it off the
 * column's left edge, so `shift` holds it in and the centres come apart. The
 * last assertion is what says the gap is `shift`'s doing.
 */
async function expectPanelHeldInColumn(
  page: Page,
  rect: { left: number; right: number; bottom: number },
): Promise<void> {
  await settlePanelUnder(page, rect);
  const view = await bodyView(page);
  const panel = await panelBox(page);
  expect(panel.left).toBeGreaterThanOrEqual(view.left);
  expect(panel.right).toBeLessThanOrEqual(view.right);
  expect((rect.left + rect.right) / 2 - panel.width / 2).toBeLessThan(view.left);
}

/** Where the panel is, and how wide. */
async function panelBox(
  page: Page,
): Promise<{ left: number; right: number; width: number; centre: number }> {
  return page.evaluate(() => {
    const r = document
      .querySelector('[data-testid="doc-link-popover"]')!
      .getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, centre: (r.left + r.right) / 2 };
  });
}

/** The body's visible area. */
async function bodyView(
  page: Page,
): Promise<{ left: number; right: number; top: number; bottom: number }> {
  return page.evaluate(() => {
    const r = document
      .querySelector('[data-testid="document-space"] .ProseMirror')!
      .closest('[data-radix-scroll-area-viewport]')!
      .getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

// G2. The bar hangs inside the body's scroller, and the container it hangs in
// is a direct child of that scroller — the same position `index.css` gives the
// wrapper Radix puts around the document. Only a real browser answers whether
// the rule aimed at that wrapper also lands on the portal's container: jsdom
// loads no stylesheet, so `min-height` is empty there whatever the selector says.
test('selecting text leaves the document as long as it was', async () => {
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  const scrollRange = async (): Promise<{ height: number; client: number }> =>
    page.evaluate(() => {
      const v = document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      ) as HTMLElement;
      return { height: v.scrollHeight, client: v.clientHeight };
    });

  const before = await scrollRange();
  await selectParagraph(page, 4);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();
  const after = await scrollRange();

  expect(after.height).toBe(before.height);

  // Where the growth came from, so a failure names it rather than only the sum.
  const portal = await page.evaluate(() => {
    const el = document.querySelector('[data-floating-ui-portal]') as HTMLElement | null;
    if (!el) return null;
    return {
      insideViewport: !!el.closest('[data-radix-scroll-area-viewport]'),
      height: Math.round(el.getBoundingClientRect().height),
      minHeight: getComputedStyle(el).minHeight,
    };
  });
  expect(portal).not.toBeNull();
  expect(portal!.insideViewport).toBe(true);
  expect(portal!.minHeight).not.toBe(`${before.client}px`);
});

test('link: an address with a space in the host leaves confirm dimmed', async () => {
  // Only a real browser answers this. The check rests on the URL parser, and
  // the two runtimes treat `https://hello world` in opposite ways: Node's
  // throws (that is the one jsdom runs), a browser's accepts it and encodes
  // the space into the host as `hello%20world` — measured in Chromium. So the
  // unit case of the same name is green for a reason other than what happens
  // in front of a user.
  await openFreshDocument(page);
  await page.keyboard.type('link me');
  await selectFirstParagraph(page);

  await page.getByTestId('doc-bubble-tool-link').click();
  const input = page.getByTestId('doc-link-input');
  const confirm = page.getByTestId('doc-link-confirm');
  await expect(input).toBeVisible({ timeout: 5_000 });

  // Light it once first. Without this line the assertion below is green even
  // against an implementation whose button never lights at all.
  await input.fill('a.example');
  await expect(confirm).toBeEnabled();

  await input.fill('hello world');
  await expect(confirm).toBeDisabled();

  // The press has to state a reason, which is the whole point of the button
  // carrying `aria-disabled`. Clicked at window coordinates, which is the path
  // where the browser runs a real hit-test — `confirm.click()` first waits for
  // the element to become enabled, and enabled is the one thing it never is.
  const box = await confirm.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByTestId('doc-link-invalid')).toBeVisible({ timeout: 5_000 });
  await expect(input).toHaveAttribute('aria-invalid', 'true');

  // The red edge the demo's fourth state draws, which `Input` gives the field
  // from that attribute. Compared against the message's own colour rather than
  // a literal, since both come from `--color-status-error-foreground` and the
  // two themes give it different values. Polled: the field carries
  // `transition-colors`, and on the frame the message appears it is still part
  // way there — measured at rgb(99, 93, 93) against rgb(206, 44, 49) settled.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const edge = getComputedStyle(
          document.querySelector('[data-testid="doc-link-input"]')!,
        ).borderTopColor;
        const message = getComputedStyle(
          document.querySelector('[data-testid="doc-link-invalid"]')!,
        ).color;
        return `${edge} | ${message}`;
      }),
    )
    .toMatch(/^(rgba?\([^)]+\)) \| \1$/);
});

test('link: the panel sits against the link it acts on', async () => {
  // Nothing has ever measured where this panel lands. The unit suite cannot:
  // every rectangle in jsdom is zero. Measured before this assertion existed,
  // the panel was drawn at the top-left corner of the window while its link sat
  // 616px to the right — its reference was a button the bubble-menu plugin had
  // already taken out of the document, so every rectangle it offered was zero.
  await openFreshDocument(page);
  await page.keyboard.type('one two three four five six seven eight');
  await selectFirstParagraph(page);

  await linkTheSelection(page, 'a.example/anchored');
  await openViewOverFirstLink(page);

  // `placement: 'bottom'` puts the two centres on top of each other, 8px apart.
  // A reference holding a degenerate rectangle lands the panel hundreds of
  // pixels away, which is what these numbers read.
  const link = await page.evaluate(() => {
    const r = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom };
  });
  expect(Math.abs((await settlePanelUnder(page, link)).centreOffset)).toBeLessThan(2);
});

test('link: the panel travels with its link when the body scrolls', async () => {
  // The panel is placed in the scrolled content's own coordinates, so the
  // scroll carries it along with the line it sits under. Measured against an
  // earlier build that placed it against the window: the link moved 260px and
  // the panel moved 7. Measured again with `shift` allowed to work vertically:
  // the link left the visible area and the panel stayed pinned to its top edge,
  // 142px away from the text it belongs to.
  await openFreshDocument(page);
  await typeLongBody(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await selectParagraph(page, 0);

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('doc-link-input').fill('a.example/scrolls');
  await page.getByTestId('doc-link-confirm').click();

  // Clicking the link selects the whole of it, which is the shape that opens
  // `view`. A `Mod-a` here would not: this paragraph holds nothing but the
  // link, so the first tier is already satisfied and the press promotes
  // straight to the document tier, where the bar carries no link button.
  await page.locator('[data-testid="document-space"] .ProseMirror a').first().click();
  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-url')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(400);

  const gap = () =>
    page.evaluate(() => {
      const panel = document
        .querySelector('[data-testid="doc-link-popover"]')!
        .getBoundingClientRect();
      const link = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
      return { gapBelow: panel.top - link.bottom, linkTop: link.top };
    });

  const before = await gap();
  await scrollBodyTo(page, 200);
  const after = await gap();

  // The link really did move under the panel.
  expect(before.linkTop - after.linkTop).toBeGreaterThan(150);
  // And the panel kept its place against it.
  expect(Math.abs(after.gapBelow - before.gapBelow)).toBeLessThan(3);
});

test('link: scrolling the target away clips the panel and keeps the draft', async () => {
  // The reason the panel hangs inside the scroller. Being clipped by an
  // ancestor's overflow is not the same as being hidden: `visibility: hidden`
  // makes the browser take focus away, and an address half typed into a field
  // that has lost focus is lost silently. Measured in Chromium: a clipped
  // field keeps focus and keeps its value, and the caret carries on where it
  // was when the reader scrolls back.
  await openFreshDocument(page);
  await typeLongBody(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await selectParagraph(page, 0);

  await page.getByTestId('doc-bubble-tool-link').click();
  const input = page.getByTestId('doc-link-input');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await page.keyboard.type('a.example/half');
  await expect(input).toBeFocused();

  const placement = () =>
    page.evaluate(() => {
      const panel = document
        .querySelector('[data-testid="doc-link-popover"]')!
        .getBoundingClientRect();
      const view = document
        .querySelector('[data-testid="document-space"] .ProseMirror')!
        .closest('[data-radix-scroll-area-viewport]')!
        .getBoundingClientRect();
      // Where the panel's own centre lands answers the question the rectangle
      // cannot: a box above the body's box is equally true of a panel plainly
      // visible over the tab strip, and being clipped rather than merely
      // elsewhere is the whole reason it is portalled into the scroller.
      const centre = document.elementFromPoint(
        Math.round(panel.left + panel.width / 2),
        Math.round(panel.top + panel.height / 2),
      );
      const el = document.querySelector('[data-testid="doc-link-popover"]')!;
      return {
        aboveTheBody: panel.bottom < view.top,
        insideTheBody: panel.top >= view.top && panel.bottom <= view.bottom,
        reachableAtItsCentre: centre !== null && el.contains(centre),
      };
    });

  const onOpen = await placement();
  expect(onOpen.insideTheBody).toBe(true);
  expect(onOpen.reachableAtItsCentre).toBe(true);

  await scrollBodyTo(page, 400);
  const scrolledAway = await placement();
  expect(scrolledAway.aboveTheBody).toBe(true);
  // Clipped, so nothing of it is at its own centre any more.
  expect(scrolledAway.reachableAtItsCentre).toBe(false);
  // Out of sight, and still holding everything the reader put into it.
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('a.example/half');

  // Typing carries on into the field nobody can see, rather than into the body.
  await page.keyboard.type('-more');
  await expect(input).toHaveValue('a.example/half-more');

  await scrollBodyTo(page, 0);
  expect((await placement()).insideTheBody).toBe(true);
  await expect(input).toHaveValue('a.example/half-more');
});

test('link: a select-all carries no link button', async () => {
  // The whole document is not a thing a link can be put on, and the panel
  // would have nothing to anchor to: over a select-all the selection's box is
  // the whole column. The rest of the bar stays — bold over everything is a
  // sensible thing to ask for.
  await openFreshDocument(page);
  await typeLongBody(page);

  // A block's worth of text carries the button, which is what makes the
  // absence below about the select-all rather than about the bar.
  await selectParagraph(page, 0);
  await expect(page.getByTestId('doc-bubble-tool-link')).toBeVisible({
    timeout: 5_000,
  });

  // Two presses from there: the first tier takes the block, the second the
  // document.
  const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
  await page.keyboard.press(selectAll);
  await page.waitForTimeout(200);
  await page.keyboard.press(selectAll);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByTestId('doc-bubble-tool-link')).toBeHidden();
});

test('link: the bar steps aside for the panel and stays away after it', async () => {
  // Two rules in one pass, because they are one pass for the reader: the bar
  // goes as the panel opens, and it does not come back when the panel closes,
  // because closing drops the selection. Held rather than caught mid-flight —
  // the bar has a 250ms debounce on selection changes, so a bar that is merely
  // recomputing is also briefly absent.
  await openFreshDocument(page);
  await page.keyboard.type('a line to link');
  await selectFirstParagraph(page);

  const bar = page.getByTestId('doc-selection-bubble-bar');
  const panel = page.getByTestId('doc-link-popover');

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(panel).toBeVisible({ timeout: 5_000 });
  await expect(bar).toBeHidden({ timeout: 5_000 });

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden({ timeout: 5_000 });
  await page.waitForTimeout(400);
  await expect(bar).toBeHidden();
  expect(
    await page.evaluate(() => {
      const selection = window.getSelection();
      return selection === null || selection.isCollapsed;
    }),
  ).toBe(true);
});

test('link: the panel is never drawn anywhere but against its target', async () => {
  // floating-ui computes a position asynchronously, so the first paint puts
  // the panel at its own origin — measured at viewport top 80, left 320, while
  // the link sat at 616. What this pins is that no such frame is ever visible:
  // every frame carrying opacity is already beside the target.
  await openFreshDocument(page);
  await page.keyboard.type('a line to link');
  await selectFirstParagraph(page);

  await page.evaluate(() => {
    (window as unknown as { __frames: unknown[] }).__frames = [];
    const frames = (window as unknown as { __frames: unknown[] }).__frames;
    const observer = new MutationObserver(() => {
      const el = document.querySelector('[data-testid="doc-link-popover"]');
      if (!el) return;
      const box = el.getBoundingClientRect();
      frames.push({
        top: Math.round(box.top),
        left: Math.round(box.left),
        opacity: Number(getComputedStyle(el).opacity),
      });
      if (frames.length > 8) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeFocused({ timeout: 5_000 });
  await page.waitForTimeout(400);

  const measured = await page.evaluate(() => {
    const frames = (window as unknown as {
      __frames: { top: number; left: number; opacity: number }[];
    }).__frames;
    const line = document
      .querySelector('[data-testid="document-space"] .ProseMirror p')!
      .getBoundingClientRect();
    return { frames, lineBottom: Math.round(line.bottom) };
  });

  expect(measured.frames.length).toBeGreaterThan(1);
  // The library's origin was among them, and it was transparent when it was.
  expect(measured.frames[0]!.opacity).toBe(0);
  measured.frames
    .filter((frame) => frame.opacity > 0)
    .forEach((frame) => {
      expect(Math.abs(frame.top - measured.lineBottom)).toBeLessThan(20);
    });
});

test('link: opening lands in the field, closing hands the caret back', async () => {
  // §8 puts this row in a browser: jsdom's focus handling is unreliable there.
  // Opening in `create` rests on `FloatingFocusManager`'s mount autofocus — the
  // panel has no focus call of its own for that state — and the bar
  // preventDefaults its own mousedown, so focus is still in the body at the
  // moment the panel opens. A failed autofocus would put the address the user
  // types into the document instead of the field. Closing hands focus back to
  // whatever held it before, which is the body.
  await openFreshDocument(page);
  await page.keyboard.type('focus me');
  await selectFirstParagraph(page);

  await page.getByTestId('doc-bubble-tool-link').click();
  const input = page.getByTestId('doc-link-input');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await expect(input).toBeFocused();

  // Typing without clicking the field first: the characters have to arrive in
  // the panel, and the body has to be left as it was.
  await page.keyboard.type('a.example');
  await expect(input).toHaveValue('a.example');
  const bodyText = await page.evaluate(
    () =>
      document.querySelector('[data-testid="document-space"] .ProseMirror')
        ?.textContent ?? '',
  );
  expect(bodyText).toBe('focus me');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-link-popover')).toBeHidden({ timeout: 5_000 });
  await expect(
    page.locator('[data-testid="document-space"] .ProseMirror'),
  ).toBeFocused();
});

test('link: pressing a link in the body reaches view without leaving the page', async () => {
  // `openOnClick` is off and `enableClickSelection` is on (§4.2), which together
  // make a press on a link select the whole of it instead of navigating. That
  // press is the only way to reach `view` with a mouse.
  await openFreshDocument(page);
  await page.keyboard.type('press this link');
  await selectFirstParagraph(page);
  await linkTheSelection(page, 'a.example/reached');

  const before = page.url();
  const openPages = page.context().pages().length;

  await page.locator('[data-testid="document-space"] .ProseMirror a').first().click();
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible({
    timeout: 5_000,
  });
  const button = page.getByTestId('doc-bubble-tool-link');
  await expect(button).toHaveAttribute('aria-pressed', 'true');

  await button.click();
  await expect(page.getByTestId('doc-link-url')).toBeVisible({ timeout: 5_000 });

  expect(page.url()).toBe(before);
  expect(page.context().pages().length).toBe(openPages);
});

test('link: with no link under it the panel sits against the selected text', async () => {
  // The other half of "the panel sits against what it acts on": in `create`
  // there is no link to measure, and the target is the selection itself.
  await openFreshDocument(page);
  await page.keyboard.type('nothing linked here yet');
  await selectFirstParagraph(page);

  // Read while the selection is still in the document: taking focus into the
  // panel empties it, which is why the panel holds a Range of its own.
  const selected = await page.evaluate(() => {
    const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom };
  });

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });

  expect(Math.abs((await settlePanelUnder(page, selected)).centreOffset)).toBeLessThan(2);
});

test('link: a target that wraps gets the panel under its last line', async () => {
  // `inline()` reads the target's per-line rectangles. For a bottom placement it
  // takes the last of them, so a link running over two lines is met under the
  // line it ends on rather than under a box drawn around both (§4.1.2).
  //
  // The width is pinned because where the sentence breaks decides how long its
  // last line is, and a short last line near the column's left edge has the
  // panel held in by `shift` instead of centred. Run after a test that left the
  // window narrow, the centre came out 26px off.
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type(
    'this sentence is deliberately long enough that the body column has to break it over more than one line before it ends',
  );
  await selectFirstParagraph(page);
  await linkTheSelection(page, 'a.example/wrapped');
  await openViewOverFirstLink(page);

  const lines = await page.evaluate(() => {
    const rects = [...document.querySelector('.ProseMirror a')!.getClientRects()];
    const last = rects[rects.length - 1]!;
    const first = rects[0]!;
    return {
      count: rects.length,
      first: { left: first.left, right: first.right, bottom: first.bottom },
      last: { left: last.left, right: last.right, bottom: last.bottom },
    };
  });

  // Without this the test would pass on a link that never wrapped.
  expect(lines.count).toBeGreaterThan(1);

  const placed = await settlePanelUnder(page, lines.last);
  const view = await bodyView(page);
  const panelWidth = await page.evaluate(
    () =>
      document.querySelector('[data-testid="doc-link-popover"]')!.getBoundingClientRect()
        .width,
  );
  // The premise of the next line: at this width the last line is far enough
  // from the column's edges for the panel to be centred on it.
  expect((lines.last.left + lines.last.right) / 2 - panelWidth / 2).toBeGreaterThan(
    view.left,
  );
  expect(Math.abs(placed.centreOffset)).toBeLessThan(2);
  // And it is the last line specifically: the first one sits a line higher.
  expect((await panelAgainst(page, lines.first)).gapBelow).toBeGreaterThan(20);
});

test('link: a target at the bottom edge keeps the panel inside the body column', async () => {
  // `shift`'s boundary is the body's visible area, so a panel that would hang
  // off the side of the column is pushed back into it (§4.1.2).
  //
  // The link is the tail of its line rather than the whole of it. A link that
  // covers a line is centred on the column, and a panel centred there stays
  // inside it whatever `shift` does — measured, dropping `shift` altogether
  // left every assertion here green.
  // Narrow enough that the panel cannot fit beside the line's end. The panel
  // has a maximum width of its own, so widening it is not a way to reach the
  // boundary — the visible area has to come down to meet it. Measured with
  // `shift` removed: the panel ran to 865 with the area ending at 760; with it
  // back, 760 exactly. At 1680 both readings are inside the area and the case
  // says nothing.
  await page.setViewportSize({ width: 760, height: 950 });
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);
  await selectParagraph(page, 2);
  await page.keyboard.press('ArrowRight');
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  await linkTheSelection(page, 'a.example/edge');
  await openViewOverFirstLink(page);

  // Bring that link down to the bottom edge, leaving part of the line showing.
  const view = await bodyView(page);
  const scroll = await page.evaluate(
    ([viewBottom]) => {
      const el = document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      )!;
      const link = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
      return el.scrollTop + link.top - (viewBottom! - 10);
    },
    [view.bottom],
  );
  await scrollBodyTo(page, scroll);

  const placed = await page.evaluate(() => {
    const panel = document
      .querySelector('[data-testid="doc-link-popover"]')!
      .getBoundingClientRect();
    const link = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
    return {
      panelLeft: Math.round(panel.left),
      panelRight: Math.round(panel.right),
      linkLeft: Math.round(link.left),
      linkRight: Math.round(link.right),
      linkVisible: link.top >= 0,
    };
  });

  // The line really is at the edge rather than gone past it.
  expect(placed.linkVisible).toBe(true);
  expect(placed.panelLeft).toBeGreaterThanOrEqual(view.left);
  expect(placed.panelRight).toBeLessThanOrEqual(view.right);
  // Pushed, rather than fitting by luck. Every other case in this file has the
  // panel centred on its target; here it cannot be, and the distance is the
  // measurement that says `shift` did the work. Measured with `shift` removed:
  // the two centres were half a pixel apart and the panel ran to 865 past a
  // boundary ending at 760.
  const panelCentre = (placed.panelLeft + placed.panelRight) / 2;
  const linkCentre = (placed.linkLeft + placed.linkRight) / 2;
  expect(Math.abs(panelCentre - linkCentre)).toBeGreaterThan(20);
});

test('link: the panel still meets its target after the window changes width', async () => {
  // A width change reflows the body, and `autoUpdate` watches for resize. The
  // link moves; the panel has to move with it.
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('resize around me');
  await selectFirstParagraph(page);
  await linkTheSelection(page, 'a.example/resized');
  await openViewOverFirstLink(page);

  const linkBox = () =>
    page.evaluate(() => {
      const r = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom };
    });

  await settlePanelUnder(page, await linkBox());
  const wide = await linkBox();
  const panelWide = await panelBox(page);

  await page.setViewportSize({ width: 1100, height: 950 });
  await page.waitForTimeout(400);
  const narrow = await linkBox();
  const panelNarrow = await panelBox(page);

  // The reflow really did move the link, so the assertions below have something
  // to be wrong about.
  expect(Math.abs(narrow.left - wide.left)).toBeGreaterThan(50);
  // And the panel went with it. This is the assertion a reference holding a
  // rectangle it measured once would fail: the panel would sit where the link
  // used to be, and every check that reads only the vertical gap would still
  // pass, since a width change leaves a one-line paragraph at the same height.
  expect(Math.abs(panelNarrow.centre - panelWide.centre)).toBeGreaterThan(20);

  // Measured 49px to the right of centre at this width.
  await expectPanelHeldInColumn(page, narrow);

  // The same event in `create`, which reaches the reference by a different
  // route: a Range over the selection rather than over a link (§5.3.1).
  await page.setViewportSize({ width: 1680, height: 950 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-link-popover')).toBeHidden({ timeout: 5_000 });
  await openFreshDocument(page);
  await page.keyboard.type('no link on this one');
  await selectFirstParagraph(page);

  const selected = () =>
    page.evaluate(() => {
      const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom };
    });
  const beforeResize = await selected();

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });
  await settlePanelUnder(page, beforeResize);
  const panelCreateWide = await panelBox(page);

  await page.setViewportSize({ width: 1100, height: 950 });
  await page.waitForTimeout(400);
  // Read from the panel's own Range: the selection is emptied once the field
  // takes focus, so the live selection has nothing left to measure.
  const afterResize = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="document-space"] .ProseMirror p')!;
    const r = document.createRange();
    r.selectNodeContents(p);
    const box = r.getBoundingClientRect();
    return { left: box.left, right: box.right, bottom: box.bottom };
  });
  expect(Math.abs(afterResize.left - beforeResize.left)).toBeGreaterThan(50);
  expect(Math.abs((await panelBox(page)).centre - panelCreateWide.centre)).toBeGreaterThan(
    20,
  );
  await expectPanelHeldInColumn(page, afterResize);

  await page.setViewportSize({ width: 1680, height: 950 });
});

test('link: the panel keeps its place while a co-editor types', async ({ browser }) => {
  // Two contexts, so two sessions and two websocket connections into the same
  // document. The panel holds a handle on the link rather than a position, and
  // a Range for its geometry; an edit above the link moves it down the page,
  // and the panel has to arrive with it.
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('the paragraph a co-editor will grow');
  await page.keyboard.press('Enter');
  await page.keyboard.type('link me');
  await selectParagraph(page, 1);
  await linkTheSelection(page, 'a.example/coedited');
  await openViewOverFirstLink(page);

  const linkBox = () =>
    page.evaluate(() => {
      const r = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
  const before = await linkBox();
  const settled = await settlePanelUnder(page, before);

  const projectUrl = page.url();
  const spaceTab = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid^="space-tab-"][aria-selected="true"]')!
        .getAttribute('data-testid')!,
  );

  const peer = await browser.newContext({ viewport: { width: 1680, height: 950 } });
  try {
    const other = await peer.newPage();
    await other.goto('/login');
    await other.locator('#login-email').fill(email as string);
    await other.locator('#login-password').fill(password as string);
    await other.locator('form button[type="submit"]').click();
    await other.waitForURL(/\/(studio|project)/, { timeout: 15_000 });

    await other.goto(projectUrl);
    await other.getByTestId(spaceTab).click();
    const peerEditor = other.locator('[data-testid="document-space"] .ProseMirror');
    await expect(peerEditor).toBeVisible({ timeout: 15_000 });
    // The link A made has to have reached B before B edits around it.
    await expect(
      other.locator('[data-testid="document-space"] .ProseMirror a'),
    ).toBeVisible({ timeout: 15_000 });

    await other.locator('[data-testid="document-space"] .ProseMirror p').first().click();
    await other.keyboard.press('End');
    await other.keyboard.type(
      ' and here is a good deal more of it, enough that the paragraph has to take a second line and push everything below it down the page',
    );

    // The peer's text has to be in this document, and the line has to have
    // moved because of it rather than because a second reader arrived.
    await expect(
      page.locator('[data-testid="document-space"] .ProseMirror'),
    ).toContainText('push everything below it down the page', { timeout: 15_000 });
    await expect.poll(async () => (await linkBox()).top - before.top).toBeGreaterThan(20);
  } finally {
    await peer.close();
  }

  const after = await linkBox();
  const moved = await panelAgainst(page, after);
  expect(Math.abs(moved.gapBelow - settled.gapBelow)).toBeLessThan(1);
  expect(Math.abs(moved.centreOffset - settled.centreOffset)).toBeLessThan(2);
  // And the panel is the same one, still in view rather than reopened.
  await expect(page.getByTestId('doc-link-url')).toBeVisible();
});

test('link: the panel is built to the demo measurements', async () => {
  // Every number here is measured off the demo's third section, which is the
  // spec for this panel: box 42 high, controls 28, the address line 21, and in
  // the refused state a 67-high box holding a 19-high message. `offsetHeight`
  // rather than a rectangle, so a transform mid-flight cannot read as a size.
  //
  // The box's own font size is left off: the demo sets 14 on it, every piece of
  // text in the panel carries its own size, and `--text-*` has no 14 rung.
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('measure me');
  await selectFirstParagraph(page);

  const sizes = () =>
    page.evaluate(() => {
      const el = (t: string) =>
        document.querySelector<HTMLElement>(`[data-testid="${t}"]`);
      const panel = el('doc-link-popover');
      return {
        panel: panel ? panel.offsetHeight : null,
        input: el('doc-link-input')?.offsetHeight ?? null,
        inputWidth: el('doc-link-input')?.offsetWidth ?? null,
        url: el('doc-link-url')?.offsetHeight ?? null,
        message: el('doc-link-invalid')?.offsetHeight ?? null,
        buttons: [...(panel?.querySelectorAll('button') ?? [])].map(
          (b) => (b as HTMLElement).offsetHeight,
        ),
      };
    });

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });
  const create = await sizes();
  expect(create).toMatchObject({
    panel: 42,
    input: 28,
    inputWidth: 250,
    buttons: [28],
  });

  await page.getByTestId('doc-link-input').fill('htp:/breatic');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-link-invalid')).toBeVisible({ timeout: 5_000 });
  expect(await sizes()).toMatchObject({ panel: 67, input: 28, message: 19 });

  await page.getByTestId('doc-link-input').fill('a.example/measured');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-link-popover')).toBeHidden({ timeout: 5_000 });
  await openViewOverFirstLink(page);
  expect(await sizes()).toMatchObject({ panel: 42, url: 21, buttons: [28, 28] });
});
