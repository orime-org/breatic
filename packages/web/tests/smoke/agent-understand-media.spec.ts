// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent looking at media a user pasted, measured end to end.
 *
 * Three kinds travel three different ways and only one of them can be checked
 * without a browser: an image goes as an address the backend fetches, while a
 * video and audio are downloaded here and go up as base64. Unit tests pin the
 * request bodies; what they cannot pin is whether that address survives the
 * whole path — tool registration, the turn's tool set, the credential, the
 * live backend — and lands as a sentence a reader can read.
 *
 * Each case starts its own conversation. A model that already has a
 * description of a puppy in front of it answers the next question from that
 * rather than from a new call, which passes every assertion below without the
 * tool having run.
 *
 * The clips are the ones every measurement behind this feature was taken
 * against, so a failure here is about our path rather than about a file whose
 * content nobody has seen.
 */
import { expect, test, type Page } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

const IMAGE = 'https://picsum.photos/id/237/400/300.jpg';
const VIDEO = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
const AUDIO = 'https://www.kozco.com/tech/piano2.wav';

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

/**
 * Ask about one address in a conversation of its own, and read the reply.
 * @param p - The page to drive.
 * @param prompt - What to type.
 * @returns The reply's text.
 */
async function askInFreshConversation(p: Page, prompt: string): Promise<string> {
  const composer = p.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  await p.getByTestId('new-conversation').click();
  await expect(p.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  await composer.fill(prompt);
  await composer.press('Enter');

  // The composer's one slot says which phase the turn is in, and the stop
  // button is the only one of the three that means "still running". So its
  // arrival is the turn starting and its departure is the turn done — a reply
  // bubble appearing says neither, because the bubble is created empty and
  // filled as the text streams.
  const abort = p.getByTestId('chat-composer-abort');
  await expect(abort).toBeVisible({ timeout: 60_000 });
  await expect(abort).toHaveCount(0, { timeout: 180_000 });

  const body = p.locator('[data-testid="markdown-body"]').last();
  await expect(body).toBeVisible({ timeout: 20_000 });
  return (await body.innerText()).trim();
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openProject(page);
});

test.afterAll(async () => {
  await page.close();
});

test('says what is in an image the user pasted', async () => {
  // A real turn against a real backend, and a real download for the kinds
  // that travel inline, so the budget is the model's rather than this
  // machine's.
  test.setTimeout(240_000);

  const reply = await askInFreshConversation(
    page,
    `看看这张图 ${IMAGE}，用一句话说清楚里面是什么。`,
  );

  // The picture is a black Labrador puppy. Asserting on the subject rather
  // than on a phrase: what a model writes about it varies run to run, what it
  // is looking at does not.
  expect(reply.length).toBeGreaterThan(0);
  expect(reply).toMatch(/狗|犬|puppy|dog|Labrador|拉布拉多/i);
});

test('says what happens in a video the user pasted', async () => {
  test.setTimeout(240_000);

  const reply = await askInFreshConversation(
    page,
    `看看这个视频 ${VIDEO}，用一句话说清楚里面发生了什么。`,
  );

  // Big Buck Bunny's opening: an animated rabbit in a meadow.
  expect(reply.length).toBeGreaterThan(0);
  expect(reply).toMatch(/兔|动画|rabbit|bunny|animat/i);
});

test('says what an audio clip sounds like', async () => {
  test.setTimeout(240_000);

  const reply = await askInFreshConversation(
    page,
    `听听这段音频 ${AUDIO}，用一句话说清楚它是什么。`,
  );

  // A solo piano recording.
  expect(reply.length).toBeGreaterThan(0);
  expect(reply).toMatch(/钢琴|音乐|piano|music|melod/i);
});

test('tells the user when the address holds nothing it can look at', async () => {
  test.setTimeout(180_000);

  const reply = await askInFreshConversation(
    page,
    '看看 https://example.com/ 这个地址，说说里面是什么。',
  );

  // The address answers text/html, which is none of the three kinds. What the
  // model does with that is its own wording; what must be true is that it
  // says so rather than describing something it never saw.
  expect(reply.length).toBeGreaterThan(0);
  expect(reply).toMatch(/不是|无法|不能|没有|失败|cannot|not a|unable|failed/i);
});
