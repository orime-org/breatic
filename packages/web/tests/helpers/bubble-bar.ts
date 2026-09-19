// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Document Space with a body to select in, and the readings taken off the
 * bubble bar that comes up over a selection.
 *
 * A spec importing this evaluates it in its own scope, so the hooks below
 * build that file's Spaces and remove them again, and neither file can reach
 * the other's (measured, playwright 1.62.1, 2026-09-19).
 *
 * Every case opens its own Space: each wants a body it wrote itself, and the
 * cases used to share one page across the file, where a red one left the next
 * reading a document it had not built.
 */
import { expect, test, type Locator, type Page } from 'playwright/test';

import { openSmokeProject } from './project';
import { createSpace, deleteSpace } from './space';

// Wide, because the column's own width decides which side the bar comes up on
// and how far it may reach.
test.use({ viewport: { width: 1680, height: 950 } });

/** The Spaces this case made, removed when it ends. */
const createdSpaceIds: string[] = [];

test.afterEach(async ({ page }) => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

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
export async function bodyViewportTop(p: Page): Promise<number> {
  return p.evaluate(() =>
    Math.round(
      document
        .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')!
        .getBoundingClientRect().top,
    ));
}

/** 条跟它锚定那一行之间的间距，跟实现里的 `GAP_FROM_SELECTION_PX` 同一个数。 */
export const GAP_FROM_SELECTION_PX = 8;

/**
 * How long a `Button` takes to change colour under the pointer.
 *
 * Its base class carries `transition-colors` (`components/ui/button.tsx:19`),
 * which Tailwind gives 150ms. Any assertion about the background a pointer
 * produced has to outlast that, or it reads the value from before the
 * transition started.
 */
export const HOVER_TRANSITION_MS = 150;

/** 进到一个新建的 Document Space，光标已在正文里。 */
export async function openFreshDocument(page: Page): Promise<void> {
  await openSmokeProject(page);

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

/**
 * Select every character of the first paragraph.
 *
 * The press waits for the editor to hold the focus: a click's focus lands
 * asynchronously, a press that arrives first is dropped, and the caret is then
 * still where the typing ended — while Cmd+A takes the paragraph the caret is
 * in. A document of one paragraph cannot tell the two apart; measured on a
 * document of two, the press without the wait took the second.
 */
export async function selectFirstParagraph(page: Page): Promise<void> {
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.locator('p').first().click();
  await expect(editor).toBeFocused();
  await page.waitForTimeout(200);
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
export async function selectParagraph(page: Page, i: number): Promise<void> {
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
export async function scrollBodyTo(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => {
    document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.scrollTo(0, top);
  }, y);
  await page.waitForTimeout(400);
}

/** 敲出一篇够长、能滚起来的正文。 */
export async function typeLongBody(page: Page): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.type(`line ${i} of a document long enough to scroll`);
    await page.keyboard.press('Enter');
  }
}

/** 浮出条相对选中那一行的位置，以及它有没有真的被画出来。 */
export async function readGeometry(page: Page): Promise<{
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

/**
 * Walk the pointer onto one opener and wait for its menu.
 *
 * Step-wise: `.hover()` teleports, and Radix
 * decides from pointer events, so a jump delivers none and the menu never
 * opens.
 * @param page - The page the bar is on.
 * @param slot - The opener's test id.
 * @returns The menu element's locator.
 */
export async function hoverOpenSlot(page: Page, slot: string): Promise<Locator> {
  const opener = page.getByTestId(slot);
  const box = (await opener.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 12,
  });
  const menu = page.getByTestId(`${slot}-menu`);
  await expect(menu).toBeVisible({ timeout: 5_000 });
  return menu;
}

/**
 * 全选：按两次 `Mod-a`。
 *
 * 一次不够——实测第一次只选中光标所在那个块（选到的文字就是那一段），走的还是
 * 「选了一部分」那一档；第二次才是整篇。判据是 `AllSelection`，所以只有第二次
 * 之后才进钉鼠标那一档。
 * @param page - 页面。
 */
export async function selectWholeDocument(page: Page): Promise<void> {
  const mod = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
  await page.keyboard.press(mod);
  await page.keyboard.press(mod);
  await page.waitForTimeout(400);
}

/** 浮出条现在在不在屏幕上，以及它在哪。 */
export async function readBar(page: Page): Promise<{
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
