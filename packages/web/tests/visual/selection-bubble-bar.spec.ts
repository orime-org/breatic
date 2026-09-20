// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the selection bubble bar draws, and where.
 *
 * Every case here measures the bar itself — the gap from the line it points
 * at, which side it comes up on, its own metrics in both colour schemes, and
 * the edges of the column it may not cross. A real browser is what answers
 * these: in jsdom every rectangle is zero.
 *
 * Needs dev running and a smoke account:
 *   pnpm --filter @breatic/web test:visual
 */
import { test, expect, type Locator } from 'playwright/test';

import {
  GAP_FROM_SELECTION_PX,
  HOVER_TRANSITION_MS,
  bodyViewportTop,
  hoverOpenSlot,
  openFreshDocument,
  readBar,
  readGeometry,
  scrollBodyTo,
  selectFirstParagraph,
  selectParagraph,
  selectWholeDocument,
  typeLongBody,
} from '../helpers/bubble-bar';
import { bodyView } from '../helpers/link-panel';

for (const scheme of ['light', 'dark'] as const) {
  test(`浮出条的位置和视觉规格（${scheme}）`, async ({ page }) => {
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
    // 四条，五组之间各一条（demo 里条下面那句说明）：块类型 ｜ 对齐 ｜ 粗体 斜体 删除线
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

test('正文滚动时浮出条跟着选区走，相对位置不变', async ({ page }) => {
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

test('上方放不下就翻到选区下方，放得下就留在上方', async ({ page }) => {
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

test('keeps the side it came up on as its line scrolls to the top (E3)', async ({ page }) => {
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

// #902 A10：图标按钮上没有地方摆「未开放」那个徽章，所以理由挂在 tooltip 和
// 可访问名上。jsdom 打不开 Radix 的 tooltip（它走 pointer 事件），只有真引擎
// 答得了这一条。
//
// 只悬停一个入口：两个走的是同一个 `ComingTool`，差别只在传进去的 props，而
// 连着悬停两个会撞上换 trigger 那一刻的中间态——新的已经开了、旧的还在关闭动
// 画里，两个 `[role=tooltip]` 同时挂在 DOM 上。那个中间态跟这条要验的事无关。
test('未开放的入口悬停时说得出自己为什么不能用', async ({ page }) => {
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

// B1 and A5/A6 in a real browser. Every hover menu on the bar had been opened
// only in jsdom, where no stylesheet loads and Radix's own pointer handling
// runs against a layout that does not exist — so what a reader sees on
// hovering one of these four had never been measured.
test('每个下拉都能悬停打开，内容照 demo，点一项只写控制台', async ({ page }) => {
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox jumps');
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  // 按 testid 而不是 menu 语义：这些菜单不接受键盘输入，所以它们不声明
  // `role="menu"`——那会向读屏宣告一套并不存在的方向键导航。
  const rowsOf = async (menu: Locator): Promise<string[]> =>
    menu.evaluate((el) =>
      [...el.querySelectorAll('[data-testid*="-item-"]')].map((r) =>
        (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));

  const blockType = await hoverOpenSlot(page, 'doc-bubble-block-type');
  expect(await rowsOf(blockType)).toHaveLength(9);
  // 九个：九行各一个。To-do list 的和弦是 Mod+Shift+9，跟有序的 7、无序的
  // 8 连成一排（`document-block-type-shortcuts.ts`）。
  expect(
    await blockType.locator('[data-testid^="doc-bubble-block-type-shortcut-"]').count(),
  ).toBe(9);

  const align = await hoverOpenSlot(page, 'doc-bubble-align');
  expect(await rowsOf(align)).toHaveLength(3);

  const colour = await hoverOpenSlot(page, 'doc-bubble-color');
  // Two rows of eight and a reset, and the cell's own measurements: 28 square
  // with the letter at 15px. The demo draws the cell 30 square; the cell stands
  // on `--btn-inline`, the step the controls above it use, which is 28
  // (`document-bubble-slots.ts`'s `COLOUR_CELL`, and CLAUDE.md's "values come
  // from our own tokens, shapes from the demo").
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
    w: '28px',
    h: '28px',
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

  const ai = await hoverOpenSlot(page, 'doc-bubble-ai');
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

test('按过浮出条之后再点到编辑器外面，条要消失', async ({ page }) => {
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

test('正文列右边放不下时，浮出条改成右边缘对齐选区左边缘', async ({ page }) => {
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

// A14 的头三条，走完一条完整的路：全选时鼠标在正文里就摆在鼠标那儿、滚动不动
// 它；鼠标在外面就不摆，滚多远都不摆；鼠标回到正文里，条自己就出来，不用滚。
// A14 还有三条在下面，各带自己的分组说明：贴着上沿、鼠标离开浏览器、窗口缩小。
test('全选时条钉在鼠标那儿，滚动不改变它的屏幕坐标', async ({ page }) => {
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

test('全选时鼠标不在正文里就不显示，鼠标不进来滚多远都不显示', async ({ page }) => {
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

test('全选后鼠标回到正文里，条自己就出来了——不用滚动', async ({ page }) => {
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
test('全选时鼠标贴着正文区域上沿，条也不画到区域外面', async ({ page }) => {
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
test('鼠标离开浏览器之后，键盘全选不把条摆出来', async ({ page }) => {
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
test('全选摆出条之后点掉选区，再在正文外全选，条不许拿旧位置回来', async ({ page }) => {
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
test('窗口缩小时，两档的条都跟着动并留在正文区域内', async ({ page }) => {
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
test('the bar leaves view with its line, and comes back with it', async ({ page }) => {
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
  expect(Math.abs(back.barTop! - start.barTop!)).toBeLessThanOrEqual(1);
});

// A16。左右都不许伸出正文显示区，两档各量一次。
test('条的左右不伸出正文显示区——选了一部分和全选各量一次', async ({ page }) => {
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

// G2. The bar hangs inside the body's scroller, and the container it hangs in
// is a direct child of that scroller — the same position `index.css` gives the
// wrapper Radix puts around the document. Only a real browser answers whether
// the rule aimed at that wrapper also lands on the portal's container: jsdom
// loads no stylesheet, so `min-height` is empty there whatever the selector says.
test('selecting text leaves the document as long as it was', async ({ page }) => {
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

// The bar's first painted frame. floating-ui needs the element in the document
// before it can measure it, so the bar enters at whatever offsets the last
// computation left behind and moves once the real ones land. Whether the
// reader sees that is the question: only a browser paints, and only a browser
// runs the frames this counts.
test('浮出条第一次画出来就在它最终的位置上', async ({ page }) => {
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  // Recorded from inside the page: a frame is a frame, and reading positions
  // over the wire samples whatever the driver happens to catch.
  await page.evaluate(() => {
    const w = window as unknown as { __barFrames?: unknown[] };
    w.__barFrames = [];
    const frames = w.__barFrames as { visible: boolean; top: number; left: number }[];
    const watch = (bar: HTMLElement): void => {
      let left = 40;
      const tick = (): void => {
        const r = bar.getBoundingClientRect();
        frames.push({
          visible: getComputedStyle(bar).visibility !== 'hidden',
          top: Math.round(r.top),
          left: Math.round(r.left),
        });
        left -= 1;
        if (left > 0 && bar.isConnected) requestAnimationFrame(tick);
      };
      tick();
    };
    new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const bar = node.matches('[data-testid="doc-selection-bubble-bar"]')
            ? node
            : node.querySelector<HTMLElement>('[data-testid="doc-selection-bubble-bar"]');
          if (bar && frames.length === 0) watch(bar);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  // Selected from the keyboard. A mouse selection hides the bar for the length
  // of the press (D1), and the press outlasts the frames this counts — so the
  // bar's entry would be covered by a gate that has nothing to do with where
  // it is placed.
  await page
    .locator('[data-testid="document-space"] .ProseMirror p')
    .nth(5)
    .click();
  await expect(page.getByTestId('doc-selection-bubble-bar')).not.toBeAttached();
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press('Shift+ArrowRight');
  }
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();
  await page.waitForTimeout(700);

  const frames = await page.evaluate(
    () =>
      (window as unknown as { __barFrames: { visible: boolean; top: number; left: number }[] })
        .__barFrames,
  );
  expect(frames.length).toBeGreaterThan(2);

  const shown = frames.filter((f) => f.visible);
  expect(shown.length).toBeGreaterThan(0);
  // Every frame the reader sees is the resting one. A bar that enters at a
  // stale offset and jumps has at least two distinct visible positions.
  const settled = shown.at(-1)!;
  expect(shown[0]).toMatchObject({ top: settled.top, left: settled.left });
});

// E3 says the bar picks its side as it comes up. D1 keeps it off screen for
// the length of a drag-select, so "as it comes up" is the release — and a side
// settled from an anchor passed through mid-drag is settled from a place the
// reader never saw. Dragging upward is where the two differ: there is room
// above the head where the drag starts and none where it ends.
test('往上拖着选到正文区顶端，松手后条整个在正文区里', async ({ page }) => {
  await openFreshDocument(page);
  await typeLongBody(page);
  // Scrolled into the body, so the line the drag ends on has the top edge just
  // above it and no room for the bar there.
  await scrollBodyTo(page, 400);

  const view = await bodyView(page);
  const paragraphs = page.locator('[data-testid="document-space"] .ProseMirror p');
  const startBox = (await paragraphs
    .filter({ hasText: 'line' })
    .first()
    .boundingBox())!;
  const x = startBox.x + 40;

  await page.mouse.move(x, view.top + 320);
  await page.mouse.down();
  await page.mouse.move(x, view.top + 20, { steps: 20 });
  await page.mouse.up();

  const bar = page.getByTestId('doc-selection-bubble-bar');
  await expect(bar).toBeVisible({ timeout: 5_000 });
  const box = (await bar.boundingBox())!;
  // 1px of tolerance: the bar is placed by a transform whose offsets carry a
  // fraction, so its edges land on fractions too.
  expect(box.y).toBeGreaterThanOrEqual(view.top - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(view.bottom + 1);
});

// E2's "全选时滚动正文，浮出条在屏幕上不动" measured inside the frame rather
// than across it. Sampling before and after a scroll settles says nothing
// about what the frame between them drew.
test('全选钉住之后滚动，条在滚动发生的那一刻就没有动', async ({ page }) => {
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);

  const view = await bodyView(page);
  await page.mouse.move(view.left + 300, view.top + 260);
  await selectWholeDocument(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  const samples = await page.evaluate(async () => {
    const bar = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement;
    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    ) as HTMLElement;
    const top = (): number => Math.round(bar.getBoundingClientRect().top);
    const frame = (): Promise<void> =>
      new Promise((r) => {
        requestAnimationFrame(() => {
          r();
        });
      });
    const out: { before: number; sameTick: number; settled: number }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const before = top();
      viewport.scrollTop += 120;
      const sameTick = top();
      await frame();
      await frame();
      out.push({ before, sameTick, settled: top() });
    }
    return out;
  });

  // Every reading is the same one: the bar does not travel with the content
  // and get pulled back, it never travels.
  for (const s of samples) {
    expect(s.sameTick).toBe(s.before);
    expect(s.settled).toBe(s.before);
  }
});
