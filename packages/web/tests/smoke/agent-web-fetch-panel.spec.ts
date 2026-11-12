// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the panel shows for the Agent's page reads (inner#1664), with the turn
 * served here rather than by a model.
 *
 * A real model decides for itself whether to read, which pages, and whether a
 * page it found by search comes back under a second spelling, so none of
 * these can be made to happen on demand. The send is answered with a run
 * whose stream opens the way the server's does (heartbeat, title, `start` with
 * an id; `helpers/fake-run.ts`, `main-agent.ts`) and carries the parts `web_search`
 * and `web_fetch` answer with (`FetchAnswer` in
 * `packages/domain/src/agent/tools/web-fetch.ts`). Every address is under a
 * reserved `.example` name: nothing here is fetched.
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { answerRuns, holdRunStreams } from '../helpers/fake-run';
import { openSmokeProject } from '../helpers/project';

test.use({ viewport: { width: 1500, height: 900 } });

/** How the server opens every run, after the heartbeat. */
const OPENING = [
  { type: 'data-conversation-titled', data: { title: 'page reads' } },
  { type: 'start', messageId: 'm-reply' },
];

/** What `web_fetch` declares for its running line (`metadata` in `makeFetchTool`). */
const FETCH_METADATA = { runningLine: 'chat.tool.readingPages' };

/** The page a search found and a read then reached under a second spelling. */
const BETA = 'https://beta.example/notes/page';

/**
 * Answer the next turn with these chunks, after the server's opening.
 * @param page - The signed-in page.
 * @param chunks - What the turn streams.
 */
async function answerWith(page: Page, chunks: object[]): Promise<void> {
  await answerRuns(page, () => [...OPENING, ...chunks]);
}


/**
 * Open a fresh conversation and send one message.
 * @param page - The signed-in page.
 */
async function send(page: Page): Promise<void> {
  await openSmokeProject(page);
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill('page read probe');
  await composer.press('Enter');
  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 20_000 });
}

/**
 * Wait for the running turn to settle.
 * @param page - The signed-in page.
 */
async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 20_000 });
}

/**
 * A step that writes one paragraph.
 * @param id - The text part's id.
 * @param text - The paragraph.
 * @returns The step's chunks.
 */
function prose(id: string, text: string): object[] {
  return [
    { type: 'start-step' },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
    { type: 'finish-step' },
  ];
}

/**
 * A `web_fetch` call on these pages, as it goes out.
 * @param id - The call's id.
 * @param urls - The pages it reads.
 * @returns The chunk.
 */
function fetchCall(id: string, urls: string[]): object {
  return {
    type: 'tool-input-available',
    toolCallId: id,
    toolName: 'web_fetch',
    input: { pages: urls.map((url) => ({ url, start: 0 })) },
    toolMetadata: FETCH_METADATA,
  };
}

test('a page found by search and read again under another spelling is one source with both numbers', async ({
  page,
}) => {
  await answerWith(page, [
    { type: 'start-step' },
    { type: 'tool-input-available', toolCallId: 's1', toolName: 'web_search', input: { query: 'notes' } },
    {
      type: 'tool-output-available',
      toolCallId: 's1',
      output: {
        query: 'notes',
        sent: 2,
        sources: [
          { url: 'https://alpha.example/intro', title: 'Alpha intro', publisher: 'alpha.example', index: 1, excerpts: ['a'] },
          { url: BETA, title: 'Beta notes', publisher: 'beta.example', index: 2, excerpts: ['b'] },
        ],
      },
    },
    { type: 'finish-step' },
    { type: 'start-step' },
    // The search's page with a trailing slash, a new site, and a page that
    // needed a login: the call ends normally with two pages read.
    fetchCall('f1', [`${BETA}/`, 'https://gamma.example/doc', 'https://delta.example/locked']),
    {
      type: 'tool-output-available',
      toolCallId: 'f1',
      output: {
        pages: [
          { url: `${BETA}/`, status: 'ok', title: 'Beta notes', chars_total: 5, start: 0, end: 5, next_start: null, text: 'beta.', links: [], index: 3 },
          { url: 'https://gamma.example/doc', status: 'ok', title: 'Gamma doc', chars_total: 6, start: 0, end: 6, next_start: null, text: 'gamma.', links: [], index: 4 },
          { url: 'https://delta.example/locked', status: 'needs_login', links: [] },
        ],
        sources: [
          { url: `${BETA}/`, title: 'Beta notes', publisher: 'beta.example', index: 3 },
          { url: 'https://gamma.example/doc', title: 'Gamma doc', publisher: 'gamma.example', index: 4 },
        ],
      },
    },
    { type: 'finish-step' },
    ...prose('t1', 'Beta says one thing [2] and the same again [3]. Gamma says another [4].'),
    { type: 'finish' },
  ]);
  await send(page);
  await settled(page);

  // Three pages, not four: the two spellings of Beta are one line.
  const opener = page.getByTestId('turn-sources');
  await expect(opener).toHaveText('Sources 3');
  await opener.click();
  const box = page.getByTestId('source-box');
  await expect(box).toBeVisible();
  const rows = box.getByTestId('source-box-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.getByTestId('source-box-marks')).toHaveText(['1', '23', '4']);
  await expect(rows.nth(1)).toContainText('Beta notes');
  await expect(rows.nth(2)).toContainText('Gamma doc');
  // The titles start at one left edge, the line with two numbers included.
  const titleLefts = await rows.evaluateAll((els) =>
    els.map((el) => Math.round(el.children[1]?.getBoundingClientRect().left ?? -1)),
  );
  expect(new Set(titleLefts).size).toBe(1);
  // The page that needed a login was not read and is not a source.
  await expect(box).not.toContainText('delta.example');
  const rowHrefs = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(rowHrefs).toEqual(['https://alpha.example/intro', BETA, 'https://gamma.example/doc']);
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();

  // Each number in the prose leads to the line that carries it: [2] and [3]
  // to the one Beta line, [4] to Gamma.
  const chips = page.getByTestId('message-bubble').last().getByTestId('citation-chip');
  await expect(chips).toHaveText(['2', '3', '4']);
  const chipHrefs = await chips.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(chipHrefs).toEqual([BETA, BETA, 'https://gamma.example/doc']);
  await chips.nth(1).hover();
  await expect(page.getByTestId('source-hover-card')).toContainText('Beta notes');
});

test('a page read that failed says which step and why', async ({ page }) => {
  await answerWith(page, [
    { type: 'start-step' },
    fetchCall('f1', ['https://delta.example/locked']),
    { type: 'tool-output-error', toolCallId: 'f1', errorText: 'chat.tool.failure.pageNeedsLogin' },
    { type: 'finish-step' },
    ...prose('t1', 'That page needs a login.'),
    { type: 'finish' },
  ]);
  await send(page);
  await settled(page);

  await expect(page.getByTestId('message-bubble-tool-failed')).toHaveText(
    'Read web pages didn\'t finish: needs a login',
  );
  await expect(page.getByTestId('turn-sources')).toHaveCount(0);
});

test('while several pages are read, the running line counts them', async ({ page }) => {
  const release = await holdRunStreams(page, '"tool-input-available"');
  await answerWith(page, [
    { type: 'start-step' },
    fetchCall('f1', ['https://gamma.example/doc', 'https://beta.example/notes/page']),
    { type: 'tool-output-error', toolCallId: 'f1', errorText: 'chat.tool.failure.pageEmpty' },
    { type: 'finish-step' },
    ...prose('t1', 'Done.'),
    { type: 'finish' },
  ]);
  await send(page);

  await expect(page.getByTestId('tool-run-line')).toHaveText('Reading 2 web pages');

  await release();
  await settled(page);
  await expect(page.getByTestId('tool-run-line')).toHaveCount(0);
});

test('while one page is read, the running line names its site', async ({ page }) => {
  const release = await holdRunStreams(page, '"tool-input-available"');
  await answerWith(page, [
    { type: 'start-step' },
    fetchCall('f1', ['https://gamma.example/doc']),
    { type: 'tool-output-error', toolCallId: 'f1', errorText: 'chat.tool.failure.pageEmpty' },
    { type: 'finish-step' },
    ...prose('t1', 'Done.'),
    { type: 'finish' },
  ]);
  await send(page);

  await expect(page.getByTestId('tool-run-line')).toHaveText('Reading gamma.example');

  await release();
  await settled(page);
  await expect(page.getByTestId('tool-run-line')).toHaveCount(0);
});
