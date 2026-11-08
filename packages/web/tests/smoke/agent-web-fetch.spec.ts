// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Agent reading pages a user pasted (inner#1664), end to end with a real
 * model, the page reader container behind the ingest Worker and the live
 * sites.
 *
 * What no intercepted spec can settle is that the whole path holds: the link
 * reaches the turn's allowed set, the server hands the read to the Worker,
 * the container opens the page, and what it read comes back as a reply and a
 * source line the user can follow.
 *
 * Whether to read is the model's call each turn: a page it knows
 * (example.com, a famous paper) it may answer from memory. These cases
 * measure the read, so a turn without a `web_fetch` call is asked again in a
 * new conversation, and a model that never reads still fails after the last
 * one. Each case runs on the conversation's default model, as every other
 * real-model Agent spec does.
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';

import { openSmokeProject } from '../helpers/project';

test.use({ viewport: { width: 1500, height: 900 } });

/** How many conversations a case asks in before it counts the model as not reading. */
const TURNS_TO_READ = 3;
/** The longest one turn takes: up to a minute to start, three to finish. */
const TURN_MS = 240_000;

test.setTimeout(TURNS_TO_READ * TURN_MS + 60_000); // three turns of up to four minutes, and the reading after

/** One tool part of a stored reply. */
interface ToolPart {
  type: string;
  state?: string;
  errorText?: string;
  output?: { sources?: Array<{ url: string }>; pages?: Array<{ url: string; status: string; text?: string }> };
}

/** What one turn left on screen and in the conversation. */
interface Turn {
  /** The reply's prose, without step failure lines. */
  reply: string;
  /** The address of every line in the source box, in order. */
  sources: string[];
  /** The turn's `web_fetch` calls, as stored. */
  fetches: ToolPart[];
  /** The turn's `web_search` calls, as stored. */
  searches: ToolPart[];
  /** How many citation chips the reply carries. */
  chips: number;
  /** The lines of the steps that did not finish. */
  failures: string[];
}

/**
 * Ask once, in a new conversation, and read what the turn left.
 * @param page - The project page.
 * @param prompt - What to type.
 * @returns The turn.
 */
async function oneTurn(page: Page, prompt: string): Promise<Turn> {
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  const sent = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/api/v1/chat/message'));
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill(prompt);
  await composer.press('Enter');
  const conversationId = ((await sent).postDataJSON() as { conversation_id: string }).conversation_id;

  // The stop button is up exactly while the turn runs.
  const abort = page.getByTestId('chat-composer-abort');
  await expect(abort).toBeVisible({ timeout: 60_000 });
  await expect(abort).toHaveCount(0, { timeout: 180_000 });

  const reply = page.getByTestId('message-bubble').last();
  const bodies = reply.getByTestId('markdown-body');
  await expect(bodies.last()).toBeVisible({ timeout: 20_000 });
  const prose = (
    await bodies.evaluateAll((els) =>
      els.map((el) => {
        const copy = el.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('[data-testid="message-bubble-tool-failed"]').forEach((line) => line.remove());
        return (copy.innerText || copy.textContent || '').trim();
      }),
    )
  ).join('\n');
  const chips = await reply.getByTestId('citation-chip').count();
  const failures = await reply.getByTestId('message-bubble-tool-failed').allInnerTexts();

  let sources: string[] = [];
  const opener = reply.getByTestId('turn-sources');
  if ((await opener.count()) > 0) {
    await opener.click();
    const box = page.getByTestId('source-box');
    await expect(box).toBeVisible();
    sources = await box
      .getByTestId('source-box-row')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('href') ?? ''));
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
  }

  const stored = await page.request.get(`/api/v1/chat/conversations/${conversationId}`);
  expect(stored.ok(), `conversation read: ${String(stored.status())}`).toBe(true);
  const { messages } = ((await stored.json()) as {
    data: { messages: Array<{ role: string; parts: ToolPart[] }> };
  }).data;
  const parts = messages.flatMap((message) => message.parts);
  return {
    reply: prose,
    sources,
    fetches: parts.filter((part) => part.type === 'tool-web_fetch'),
    searches: parts.filter((part) => part.type === 'tool-web_search'),
    chips,
    failures,
  };
}

/**
 * Ask until a turn reads a page, each time in a conversation of its own.
 * @param page - The project page.
 * @param prompt - What to type.
 * @returns The first turn that called `web_fetch`.
 * @throws {Error} When no turn reads.
 */
async function askUntilRead(page: Page, prompt: string): Promise<Turn> {
  await openSmokeProject(page);
  await expect(page.getByTestId('chat-composer-box')).toBeVisible({ timeout: 20_000 });
  for (let turn = 1; turn <= TURNS_TO_READ; turn += 1) {
    const result = await oneTurn(page, prompt);
    if (result.fetches.length > 0) return result;
  }
  throw new Error(`no turn of ${String(TURNS_TO_READ)} called web_fetch`);
}

/**
 * One page however its address is spelled: host without `www.`, path without
 * a trailing slash.
 * @param url - The address.
 * @returns The page's key, or the address itself when it does not parse.
 */
function pageOf(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, '')}${pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/**
 * Whether an address is on this host.
 * @param url - The address.
 * @param host - The host, without `www.`.
 * @returns True when it is.
 */
function onHost(url: string, host: string): boolean {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === host;
  } catch {
    return false;
  }
}

test('a pasted page is read and listed as a source @needs-model @needs-ingest @needs-internet', async ({ page }) => {
  const turn = await askUntilRead(page, 'Read this page and tell me what it says: https://example.com/');

  expect(turn.reply).toMatch(/Example Domain|illustrative examples|documentation examples|without (prior )?(coordination|permission)/i);
  expect(turn.sources.some((url) => onHost(url, 'example.com'))).toBe(true);
});

test('a pasted PDF is read and its title given @needs-model @needs-ingest @needs-internet', async ({ page }) => {
  const turn = await askUntilRead(page, 'Read this PDF and tell me its title: http://arxiv.org/pdf/1706.03762');

  expect(turn.reply).toMatch(/Attention Is All You Need/i);
  expect(turn.sources.some((url) => onHost(url, 'arxiv.org'))).toBe(true);
});

const REFUSING = 'https://www.zhihu.com/question/19550225';

test('a page whose site refuses to be read is not a source, and the user is asked for the text @needs-model @needs-ingest @needs-internet', async ({
  page,
}) => {
  const turn = await askUntilRead(page, `Read this page and summarise it: ${REFUSING}`);

  // The read recorded the refusal: a call that read nothing ended on the
  // pageRefused line, or a call that read something else marked this page
  // refused. Which one depends on what else the model asked for in the call,
  // so the stored call is read rather than the line on screen (plan §9 X).
  const refusedAll = turn.fetches.some((part) => part.errorText === 'chat.tool.failure.pageRefused');
  const refusedPage = turn.fetches.some((part) =>
    (part.output?.pages ?? []).some((p) => p.status === 'refused' && pageOf(p.url) === pageOf(REFUSING)),
  );
  expect(refusedAll || refusedPage, JSON.stringify(turn.fetches)).toBe(true);
  // The refused page is not a source. Other pages of the same site may be:
  // the model is free to search after the refusal, and a search can find them.
  expect(turn.sources.map(pageOf)).not.toContain(pageOf(REFUSING));
  expect(turn.reply).toMatch(/cop(y|ied)|paste|screenshot|PDF/i);
});

test('a page found by search is read, and both are sources the reply cites @needs-model @needs-search @needs-ingest @needs-internet', async ({
  page,
}) => {
  const turn = await askUntilRead(
    page,
    'Search the web for the Wikipedia article on the Eiffel Tower, then read that article and tell me how tall the tower is.',
  );

  const searched = turn.searches.flatMap((part) => part.output?.sources ?? []).map((s) => s.url);
  const read = turn.fetches.flatMap((part) => part.output?.sources ?? []).map((s) => s.url);
  expect(searched.length).toBeGreaterThan(0);
  expect(read.length).toBeGreaterThan(0);
  // The pages the read reached are lines in the box, beside the ones the
  // search found; a page both found and read is one line.
  const hosts = turn.sources.map((url) => new URL(url).hostname);
  for (const url of read) expect(hosts).toContain(new URL(url).hostname);
  expect(turn.sources.length).toBeGreaterThan(1);
  expect(turn.chips).toBeGreaterThan(0);
  expect(turn.reply).toMatch(/\d{3}/);
});

/**
 * Whether a reply repeats a run of a page's text: some stretch of `length`
 * characters, spaces left out on both sides, appears in both.
 * @param reply - The reply.
 * @param text - The page's text as read.
 * @param length - How long the shared stretch must be.
 * @returns True when the reply quotes the page.
 */
function quotes(reply: string, text: string, length = 8): boolean {
  const said = reply.replace(/\s+/g, '');
  const page = text.replace(/\s+/g, '');
  for (let at = 0; at + length <= said.length; at += 1) {
    const stretch = said.slice(at, at + length);
    if (/[\p{L}\p{N}]{4}/u.test(stretch) && page.includes(stretch)) return true;
  }
  return false;
}

test('a page that builds its text with scripts, the 36Kr newsflash list, is read and quoted @needs-model @needs-ingest @needs-internet', async ({
  page,
}) => {
  const turn = await askUntilRead(
    page,
    'Read https://36kr.com/newsflashes and quote the first two newsflash headlines on it word for word.',
  );

  const read = turn.fetches.flatMap((part) => part.output?.pages ?? []).filter((p) => p.status === 'ok');
  expect(read.length, JSON.stringify(turn.fetches)).toBeGreaterThan(0);
  const pageText = read.map((p) => p.text ?? '').join('\n');
  expect(quotes(turn.reply, pageText), turn.reply).toBe(true);
  expect(turn.sources.some((url) => onHost(url, '36kr.com'))).toBe(true);
});
