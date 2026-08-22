// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 整篇文档命令那个入口的 E2E（任务 #129）。
 *
 * 这里只放 jsdom 量不了的那些：入口在屏幕上的实际位置、常驻面积、点开之后
 * 菜单画在哪儿、它跟正文列和浮出条的几何关系、滚轮落在它上面时正文照样滚。
 * 展开后装哪两项、每项的尚未开放态由 `document-menu-entry.test.tsx` 逐条钉住
 * （jsdom 答得了），这里不重复。
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

test('the entry sticks inside the scroller, not beside it', async () => {
  // It has to be inside for the wheel to reach the body, and stuck to the top
  // so it keeps its corner while the text scrolls under it. Anything added as
  // a direct child of the shell turns the first assertion red, whatever it is
  // called; portalled layers are not children and do not count.
  await openFreshDocument(page);
  const layout = await page.evaluate(() => {
    const scroller = document.querySelector('.doc-body-scroller')!;
    const viewport = scroller.querySelector('[data-radix-scroll-area-viewport]')!;
    const trigger = document.querySelector(
      '[data-testid="doc-doc-menu-trigger"]',
    )!;
    const layer = trigger.parentElement!;
    return {
      shellChildren: scroller.parentElement!.children.length,
      insideViewport: viewport.contains(trigger),
      aheadOfPage: viewport.firstElementChild!.contains(trigger),
      position: getComputedStyle(layer).position,
    };
  });

  expect(layout.shellChildren).toBe(1);
  expect(layout.insideViewport).toBe(true);
  expect(layout.aheadOfPage).toBe(true);
  expect(layout.position).toBe('sticky');
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

  // The three numbers come from `--doc-entry-size` and `--doc-entry-inset`
  // (`index.css`), which also size the gutter the button stands in. Asserted
  // exactly: a range wide enough to swallow a changed token proves nothing.
  expect(geometry.width).toBe(32);
  expect(geometry.height).toBe(32);
  expect(geometry.insetRight).toBe(16);
  expect(geometry.insetTop).toBe(20);
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

test('the page clears the entry, down to the width where it used to not', async () => {
  // The page is centred inside the viewport's padding; the entry stands in the
  // right half of that padding. Below a certain content width the page grows
  // into it and a click at the end of the first line opens the menu instead
  // (measured 2026-08-22 with the old 24px gutter: 1000 / 1060 / 1100 / 1140
  // all did this). Two things per width: the rectangles miss each other, and
  // the end of the first line really is the page.
  //
  // The widths below are window widths, and what decides the outcome is the
  // content area — narrower than the window by whatever chrome is open. The
  // assertion after the loop keeps this test honest: unless one of the runs
  // lands under the threshold where a too-narrow gutter would overlap, the
  // whole loop passes with the bug present.
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  await page.keyboard.type(
    '这是一段刻意写得很长的正文它会在正文列里折成好几行每一行的行尾都会顶到列的右边界' +
      '所以拿它来量入口有没有压住正文最合适不过了继续写下去让它至少折出三四行来',
  );

  const contentWidths: number[] = [];
  for (const width of [1000, 1140, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);

    const shot = await page.evaluate(() => {
      const pm = document.querySelector(
        '[data-testid="document-space"] .ProseMirror',
      )!;
      const trigger = document.querySelector(
        '[data-testid="doc-doc-menu-trigger"]',
      )!;
      const page_ = pm.getBoundingClientRect();
      const t = trigger.getBoundingClientRect();

      // 第一条视觉行的最后一个字符
      const text = pm.querySelector('p')!.firstChild as Text;
      const topOf = (i: number): number => {
        const r = document.createRange();
        r.setStart(text, i);
        r.setEnd(text, i + 1);
        return Math.round(r.getBoundingClientRect().top);
      };
      const firstTop = topOf(0);
      let last = 0;
      for (let i = 0; i < text.length; i += 1) {
        if (topOf(i) !== firstTop) break;
        last = i;
      }
      const r = document.createRange();
      r.setStart(text, last);
      r.setEnd(text, last + 1);
      const tail = r.getBoundingClientRect();

      const hit = document.elementFromPoint(
        (tail.left + tail.right) / 2,
        (tail.top + tail.bottom) / 2,
      );
      const viewport = document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      )!;
      return {
        overlaps: page_.right > t.left && page_.top < t.bottom,
        hitTestId: hit?.closest('[data-testid]')?.getAttribute('data-testid'),
        contentWidth: viewport.getBoundingClientRect().width,
      };
    });

    expect(shot.overlaps, `window ${width}: the page runs under the entry`).toBe(
      false,
    );
    expect(
      shot.hitTestId,
      `window ${width}: the end of the first line is not the page`,
    ).toBe('document-editor-content');
    contentWidths.push(shot.contentWidth);
  }

  // Overlap happens when the content area is narrower than the page plus both
  // gutters — that is the only region where this test can tell a right gutter
  // from a wrong one.
  const threshold = await page.evaluate(() => {
    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    )!;
    const page_ = document.querySelector(
      '[data-testid="document-editor-content"]',
    )!;
    const gutter = parseFloat(getComputedStyle(viewport).paddingLeft);
    const maxPage = parseFloat(getComputedStyle(page_).maxWidth);
    return maxPage + 2 * gutter;
  });
  expect(
    Math.min(...contentWidths),
    `every width tested was wide enough to pass with any gutter (threshold ${threshold})`,
  ).toBeLessThan(threshold);

  await page.setViewportSize({ width: 1680, height: 950 });
});

test('浮出条压过入口：重叠的那一块归浮出条', async () => {
  // 两者是同一个隔离容器里的定位兄弟，条的横向位置跟着选区走、能一直伸到
  // 入口那个角（2026-08-22 实测 1440 档两者只差 1px）。真实重叠只在很窄的
  // 一条边界上出现，所以这里把条挪过去造出重叠 —— 钉的是「重叠时谁在上」，
  // 跟重叠是怎么来的无关。
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  await page.keyboard.type('拿来选中的一段文字');

  await page.evaluate(() => {
    const pm = document.querySelector(
      '[data-testid="document-space"] .ProseMirror',
    )!;
    const text = pm.querySelector('p')!.firstChild as Text;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(text, 1);
    r.setEnd(text, 5);
    sel.removeAllRanges();
    sel.addRange(r);
    pm.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible({
    timeout: 5_000,
  });

  const hit = await page.evaluate(() => {
    const trigger = document.querySelector(
      '[data-testid="doc-doc-menu-trigger"]',
    )!;
    const bar = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement;
    const t = trigger.getBoundingClientRect();
    const origin = bar.parentElement!.getBoundingClientRect();
    bar.style.left = `${t.left - origin.left}px`;
    bar.style.top = `${t.top - origin.top}px`;
    const el = document.elementFromPoint(t.left + 16, t.top + 16);
    return el?.closest('[data-testid]')?.getAttribute('data-testid');
  });

  expect(hit).toMatch(/^doc-bubble-tool-/);
});

test('a wheel over the entry scrolls the body', async () => {
  // The entry sits inside the scroller, so this is the browser's own scroll
  // chain rather than anything we wired. Driven through the real pointer:
  // dispatching the event at the element would skip hit-testing, which is the
  // half that decides whether a wheel there reaches the body at all.
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.type(`line ${i} — long enough to scroll`);
    await page.keyboard.press('Enter');
  }

  const readTop = (): Promise<number> =>
    page.evaluate(
      () =>
        (
          document.querySelector(
            '.doc-body-scroller [data-radix-scroll-area-viewport]',
          ) as HTMLElement
        ).scrollTop,
    );
  await page.evaluate(() => {
    (
      document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      ) as HTMLElement
    ).scrollTop = 0;
  });

  const box = (await page.getByTestId('doc-doc-menu-trigger').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await readTop();
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);

  expect(await readTop()).toBeGreaterThan(before);
});

test('按 Escape 收起菜单', async () => {
  await openFreshDocument(page);
  await page.getByTestId('doc-doc-menu-trigger').click();
  const item = page.getByTestId('doc-doc-menu-save-snapshot');
  await expect(item).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press('Escape');
  await expect(item).toHaveCount(0);
});
