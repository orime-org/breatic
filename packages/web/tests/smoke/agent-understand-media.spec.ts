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
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';

import { openSmokeProject } from '../helpers/project';

const IMAGE = 'https://picsum.photos/id/237/400/300.jpg';
const VIDEO = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
const AUDIO = 'https://www.kozco.com/tech/piano2.wav';
// Served as video/x-msvideo — measured against this host, and not one of the
// four video types the endpoint takes.
const AVI = 'https://filesamples.com/samples/video/avi/sample_640x360.avi';
// Served as image/svg+xml, which the endpoint does not read from an address:
// measured, it answers 400 "Supported formats: PNG, JPEG, WebP, GIF."
const SVG = 'https://upload.wikimedia.org/wikipedia/commons/f/fd/Ghostscript_Tiger.svg';

/** The understand_media call of a turn, as the conversation stores it. */
interface UnderstandCall {
  state: string;
  input?: { url?: unknown };
  output?: unknown;
  failureKind?: string;
  errorText?: string;
}

let page: Page;

/**
 * Whether a call's address is the one asked about, written either way the
 * model may write it (`https://example.com` and `https://example.com/`).
 * @param url - The address in the call's input.
 * @param asked - The address asked about, already normalised.
 * @returns Whether they name the same resource.
 */
function sameAddress(url: unknown, asked: string): boolean {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).href === asked;
  } catch {
    return false;
  }
}

/** How many conversations a case asks in before it counts the model as not looking. */
const TURNS_TO_LOOK = 3;
/** The longest one turn takes: up to a minute to start, three to finish, and the reading after. */
const TURN_MS = 240_000;

test.setTimeout(TURNS_TO_LOOK * TURN_MS + 60_000);

/** What one turn left: the reply, the running-tool lines, and the call made on the address. */
interface Turn {
  reply: string;
  toolLines: string;
  call: UnderstandCall | null;
}

/**
 * Ask about one address until the model calls understand_media on it, each
 * time in a conversation of its own.
 *
 * Whether to call the tool is the model's choice each turn: an address it
 * knows (example.com) it may describe from memory, and after a refusal it may
 * go on to look at another copy of the same picture. What these cases measure
 * is our path for this address, so they read the call made on it, and a turn
 * without one is asked again.
 * @param p - The page to drive.
 * @param prompt - What to type.
 * @param address - The address the call has to be made on.
 * @returns The turn that looked at the address.
 * @throws {Error} When no turn calls the tool on the address.
 */
async function askInFreshConversation(p: Page, prompt: string, address: string): Promise<Turn> {
  for (let turn = 1; turn <= TURNS_TO_LOOK; turn += 1) {
    const result = await oneTurn(p, prompt, address);
    if (result.call !== null) return result;
  }
  throw new Error(`no turn of ${String(TURNS_TO_LOOK)} called understand_media on ${address}`);
}

/**
 * Ask once, in a new conversation, and read the reply.
 * @param p - The page to drive.
 * @param prompt - What to type.
 * @param address - The address whose call is read.
 * @returns The reply's text, what the running-tool line said while the turn
 * was going, and the turn's last understand_media call on the address.
 */
async function oneTurn(p: Page, prompt: string, address: string): Promise<Turn> {
  const composer = p.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  await startNewConversation(p);
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

  const sent = p.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/api/v1/chat/message'));
  await composer.fill(prompt);
  await composer.press('Enter');
  const conversationId = ((await sent).postDataJSON() as { conversation_id: string }).conversation_id;

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
  // What the tool itself answered, as the conversation stored it: the model's
  // reply around it is its own wording, and the call is what our path did.
  const stored = await p.request.get(`/api/v1/chat/conversations/${conversationId}`);
  expect(stored.ok(), `conversation read: ${String(stored.status())}`).toBe(true);
  const { messages } = ((await stored.json()) as {
    data: { messages: { role: string; parts: ({ type: string } & UnderstandCall)[] }[] };
  }).data;
  const asked = new URL(address).href;
  const call =
    messages
      .flatMap((m) => m.parts)
      .filter((part) => part.type === 'tool-understand_media' && sameAddress(part.input?.url, asked))
      .at(-1) ?? null;
  return { reply: (await body.innerText()).trim(), toolLines, call };
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
  });
  await openSmokeProject(page);
});

test.afterEach(async () => {
  await page.close();
});

test('says what is in an image the user pasted @needs-internet @needs-model', async () => {
  const { toolLines, call } = await askInFreshConversation(
    page,
    `看看这张图 ${IMAGE}，用一句话说清楚里面是什么。`,
    IMAGE,
  );

  // The call having run and answered is what says the address travelled our
  // path, and the subject in its answer is what says the answer is about this
  // picture. It is a black Labrador puppy, and the address does not say so.
  expect(toolLines).toContain('Looking at the media');
  expect(call?.state).toBe('output-available');
  expect(String(call?.output)).toMatch(/puppy|dog|Labrador|狗|犬/i);
});

test('says what happens in a video the user pasted @needs-internet @needs-model', async () => {

  const { toolLines, call } = await askInFreshConversation(
    page,
    `看看这个视频 ${VIDEO}，用一句话说清楚里面发生了什么。`,
    VIDEO,
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
  expect(call?.state).toBe('output-available');
  expect(String(call?.output)).toMatch(/tree|grass|meadow|forest|clearing|树|草|森林/i);
});

test('says what an audio clip sounds like @needs-internet @needs-model', async () => {

  const { toolLines, call } = await askInFreshConversation(
    page,
    `听听这段音频 ${AUDIO}，用一句话说清楚它是什么。`,
    AUDIO,
  );

  // The file is named piano2.wav and the name is in the prompt, so "piano" in
  // the answer says nothing about whether anything was listened to. The tool
  // having run is the assertion; the word only says the answer is about this
  // file rather than the previous one.
  expect(toolLines).toContain('Looking at the media');
  expect(call?.state).toBe('output-available');
  expect(String(call?.output)).toMatch(/piano|music|melod|钢琴|音乐/i);
});

test('says what it is doing while the call is in flight @needs-internet @needs-model', async () => {
  test.setTimeout(240_000);

  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
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

test('tells the user a video format it cannot watch is one to convert @needs-internet @needs-model', async () => {

  // An .avi, served as video/x-msvideo — a real type from a real host, and not
  // one of the four the endpoint names. The refusal happens on our side before
  // a byte travels, so what must reach the reader is that the format is the
  // problem and converting is the move. The failing shape this replaces sent
  // the whole clip up and then repeated the endpoint's complaint, which reads
  // as the model having declined to watch it.
  const { reply, call } = await askInFreshConversation(
    page,
    `看看这个视频 ${AVI}，说说里面有什么。`,
    AVI,
  );

  // Refused by our own check: the call ended as a tool failure, which is the
  // ending that carries the sentence telling the model to ask for a convert.
  expect(call?.state).toBe('output-error');
  expect(call?.failureKind).toBe('tool_failed');
  // The line for a refusal of our own. The endpoint turning the file down
  // would show the upstream line instead.
  expect(call?.errorText).toBe('chat.tool.failure.generic');
  expect(reply.length).toBeGreaterThan(0);
});

test('tells the user an image format it cannot read is one to convert @needs-internet @needs-model', async () => {

  // The other half of the format gate, and the one a reader hits by accident:
  // most encyclopedia diagrams are svg. Before the gate this went to the model
  // and came back as an upstream failure — "try again shortly", for an address
  // that answers the same way every time.
  const { reply, call } = await askInFreshConversation(
    page,
    `看看这张图 ${SVG}，说说里面是什么。`,
    SVG,
  );

  expect(call?.state).toBe('output-error');
  expect(call?.failureKind).toBe('tool_failed');
  expect(call?.errorText).toBe('chat.tool.failure.generic');
  expect(reply.length).toBeGreaterThan(0);
});

test('tells the user when the address holds nothing it can look at @needs-internet @needs-model', async () => {

  // Put as a picture: asked about a plain web page, the model may search for
  // it rather than look at it, and this case is about the look.
  const { reply, call } = await askInFreshConversation(
    page,
    '这是一张图片的地址：https://example.com/?image=cover.png ，看看画的是什么。',
    'https://example.com/?image=cover.png',
  );

  // The address answers text/html, which is none of the three kinds: the call
  // ends as a tool failure, so there is no description for the model to give.
  expect(call?.state).toBe('output-error');
  expect(call?.failureKind).toBe('tool_failed');
  expect(reply.length).toBeGreaterThan(0);
});
