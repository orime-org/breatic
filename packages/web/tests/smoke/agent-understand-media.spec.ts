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
// Served as video/x-msvideo — measured against this host, and not one of the
// four video types the endpoint takes.
const AVI = 'https://filesamples.com/samples/video/avi/sample_640x360.avi';

// A turn that failed renders the same running line as one that worked — the
// line goes up when `execute` starts and says nothing about how it ended, and
// nothing on screen names a tool failure today (#94). So the only signal left
// is whether the reply is a description or an account of not having been able
// to look. The words below are the ones such an account uses; a description of
// the media itself has no reason to reach for them.
const REPORTS_A_FAILURE = /无法|不能|失败|cannot|unable|failed/i;

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
 * @returns The reply's text, and what the running-tool line said while the
 * turn was going.
 */
async function askInFreshConversation(
  p: Page,
  prompt: string,
): Promise<{ reply: string; toolLines: string }> {
  const composer = p.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  await p.getByTestId('new-conversation').click();
  await expect(p.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  // Watched rather than awaited: the line for a running tool is on screen only
  // while that tool runs, and a turn that finishes between two assertions
  // would look the same as a turn that called nothing. The observer is
  // installed before the question goes out and outlives the whole turn.
  //
  // The text, because every tool renders this line and web_search is in the
  // same set: on a deployment with no credential this tool is left out of the
  // set entirely and the model reaches for search instead, which would satisfy
  // "some tool ran" and, on these filenames, most of the words too.
  await p.evaluate(() => {
    const w = window as unknown as { __toolLines?: string };
    const read = (): void => {
      const line = document.querySelector('[data-testid="tool-run-line"]')?.textContent;
      if (line) w.__toolLines = `${w.__toolLines ?? ''}|${line}`;
    };
    w.__toolLines = '';
    read();
    new MutationObserver(read).observe(document.body, { childList: true, subtree: true });
  });

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
  const toolLines = await p.evaluate(
    () => (window as unknown as { __toolLines?: string }).__toolLines ?? '',
  );
  return { reply: (await body.innerText()).trim(), toolLines };
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

  const { reply, toolLines } = await askInFreshConversation(
    page,
    `看看这张图 ${IMAGE}，用一句话说清楚里面是什么。`,
  );

  // Two assertions, because the words alone do not separate a model that
  // looked from one that guessed: the tool having run is what says the address
  // travelled our path, and the subject is what says the answer is about this
  // picture. It is a black Labrador puppy, and the address does not say so.
  expect(toolLines).toContain('Looking at the media');
  expect(reply).toMatch(/狗|犬|puppy|dog|Labrador|拉布拉多/i);
  expect(reply).not.toMatch(REPORTS_A_FAILURE);
});

test('says what happens in a video the user pasted', async () => {
  test.setTimeout(240_000);

  const { reply, toolLines } = await askInFreshConversation(
    page,
    `看看这个视频 ${VIDEO}，用一句话说清楚里面发生了什么。`,
  );

  // The first ten seconds of Big Buck Bunny, which is what this clip holds:
  // a slow push across a grassy clearing towards one large tree with a burrow
  // under its roots. The rabbit the film is named for has not come out yet, so
  // naming it here would be asking the model to describe footage it was not
  // given — measured, a passing answer is "宁静的森林空地空镜头：阳光洒在长满
  // 草的小土丘和一棵大树（树根下有个洞穴）上".
  // The film's name would carry a reader to "forest" on its own, so the
  // sentence is the weaker half here and the tool having run is the strong one.
  expect(toolLines).toContain('Looking at the media');
  expect(reply).toMatch(/树|草|森林|林间|tree|grass|meadow|forest|clearing/i);
  expect(reply).not.toMatch(REPORTS_A_FAILURE);
});

test('says what an audio clip sounds like', async () => {
  test.setTimeout(240_000);

  const { reply, toolLines } = await askInFreshConversation(
    page,
    `听听这段音频 ${AUDIO}，用一句话说清楚它是什么。`,
  );

  // The file is named piano2.wav and the name is in the prompt, so "piano" in
  // the answer says nothing about whether anything was listened to. The tool
  // having run is the assertion; the word only says the answer is about this
  // file rather than the previous one.
  expect(toolLines).toContain('Looking at the media');
  expect(reply).toMatch(/钢琴|音乐|piano|music|melod/i);
  expect(reply).not.toMatch(REPORTS_A_FAILURE);
});

test('says what it is doing while the call is in flight', async () => {
  test.setTimeout(240_000);

  const composer = page.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  // A video, because this line lives only while the call runs and the video
  // path is the long one: the clip is downloaded here and sent up as base64.
  await composer.fill(`看看这个视频 ${VIDEO}，说说里面有什么。`);
  await composer.press('Enter');

  const line = page.getByTestId('tool-run-line');
  await expect(line).toBeVisible({ timeout: 90_000 });
  await expect(line).toHaveText(/Looking at the media/);
  await page.screenshot({ path: 'test-results/understand-media-running-line.png' });

  // Let the turn finish rather than leaving it to be aborted by the next
  // case, which is what a half-read reply and a stopped stream come from.
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 180_000 });
});

test('tells the user a video format it cannot watch is one to convert', async () => {
  test.setTimeout(180_000);

  // An .avi, served as video/x-msvideo — a real type from a real host, and not
  // one of the four the endpoint names. The refusal happens on our side before
  // a byte travels, so what must reach the reader is that the format is the
  // problem and converting is the move. The failing shape this replaces sent
  // the whole clip up and then repeated the endpoint's complaint, which reads
  // as the model having declined to watch it.
  const { reply } = await askInFreshConversation(
    page,
    `看看这个视频 ${AVI}，说说里面有什么。`,
  );

  expect(reply).toMatch(/格式|转换|convert|format/i);
  expect(reply).not.toMatch(/模型(拒绝|不(愿|肯))|would not answer|refused/i);
});

test('tells the user when the address holds nothing it can look at', async () => {
  test.setTimeout(180_000);

  const { reply } = await askInFreshConversation(
    page,
    '看看 https://example.com/ 这个地址，说说里面是什么。',
  );

  // The address answers text/html, which is none of the three kinds. What the
  // model does with that is its own wording; what must be true is that it
  // says so rather than describing something it never saw.
  expect(reply.length).toBeGreaterThan(0);
  expect(reply).toMatch(/不是|无法|不能|没有|失败|cannot|not a|unable|failed/i);
});
