// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A question the agent asked, measured in a browser.
 *
 * The server draws the question and its options as markdown and writes them
 * into the reply's own text, so what a reader ends up with is decided by a
 * markdown parser and a stylesheet. The stylesheet is what jsdom does not
 * settle and what this case is here for: whether the list carries visible
 * numbers, which Preflight strips and a rule in `index.css` writes back.
 * Removing that rule turns this red.
 *
 * The escaping assertions below are a net, not a pin. Which characters reach
 * a reader is the model's choice, and the shape it writes -- one `~` to a
 * list item -- is one the escape makes no difference to, so dropping
 * `gfmToMarkdown()` leaves this green. What holds that side is
 * `ask-user-text.test.ts`, where the same drop turns two cases red.
 *
 * The turn is real, so the model decides whether to ask. The prompt below asks
 * for something it cannot answer without knowing more, which is the case the
 * tool exists for; a run where it answers instead is reported as such rather
 * than passed. Each run starts a conversation of its own, because a model
 * shown a question of its own already waiting for an answer writes the next
 * one out in prose instead of asking again -- measured three runs in a fresh
 * conversation, three asks; the same sentence in a conversation already
 * holding an unanswered question, prose.
 */
import { expect, test, type Page } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

let page: Page;

/**
 * Sign in and open the account's first project.
 * @param p - The page to drive.
 * @returns Nothing.
 * @throws {Error} When sign-in never reaches a project.
 */
async function openProject(p: Page): Promise<void> {
  await p.goto('/login');
  await p.locator('#login-email').fill(email as string);
  await p.locator('#login-password').fill(password as string);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL(/\/(studio|project)/, { timeout: 20_000 });
  await p.goto('/studio');
  const first = p.locator('a[href^="/project/"]').first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.click();
  await p.waitForURL(/\/project\//, { timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openProject(page);
});

test.afterAll(async () => {
  await page.close();
});

test('the question and its options arrive as a numbered list', async () => {
  // A real turn, so the wait is on a model rather than on this machine. The
  // file's own default of 30s is what a page is given, and it caps every
  // wait inside a case regardless of what that wait asks for.
  test.setTimeout(120_000);
  const composer = page.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  const waiting = page.getByTestId('message-bubble-blocked');
  // Its own conversation, so that what this measures is what this turn
  // produced. Reusing the one chat opens with reads a question an earlier run
  // left there, which satisfies every assertion below without this turn
  // having run at all.
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  await composer.fill(
    '我要做一条短视频，时长在 20~25 秒到 30~35 秒之间还没定，预算 $$100 或 $$300，' +
      '素材在 https://a.com/photo_1.jpg。你先问我一个问题把还没定的那件事定下来，' +
      '把每个选项都放进这次提问里。',
  );
  await composer.press('Enter');

  await expect(waiting).toHaveCount(1, { timeout: 60_000 });

  const body = page.locator('[data-testid="markdown-body"]').last();
  const list = body.locator('ol').last();
  await expect(list).toBeVisible();

  // Numbers on screen: Preflight ships `list-style: none`, so this is the
  // rule in `index.css` winning, not a default.
  const listStyle = await list.evaluate((el) => getComputedStyle(el).listStyleType);
  expect(listStyle).toBe('decimal');

  const items = await list.locator('li').allInnerTexts();
  expect(items.length).toBeGreaterThanOrEqual(2);
  expect(items.length).toBeLessThanOrEqual(5);
  for (const item of items) expect(item.trim().length).toBeGreaterThan(0);

  // Whatever this run's characters turned out to be, none of them reach the
  // reader as a backslash and none are read back as syntax.
  const text = (await body.innerText()).trim();
  expect(text).not.toMatch(/\\[~$_#>|[\]]/);
  expect(await body.locator('del').count()).toBe(0);
  expect(await body.locator('.katex').count()).toBe(0);
});

test('the reader gets the same question back after a reload', async () => {
  const before = (await page.locator('[data-testid="markdown-body"]').last().innerText()).trim();

  await page.reload();
  await expect(page.getByTestId('message-bubble-blocked')).toBeVisible({ timeout: 30_000 });

  const after = (await page.locator('[data-testid="markdown-body"]').last().innerText()).trim();
  expect(after).toBe(before);
});
