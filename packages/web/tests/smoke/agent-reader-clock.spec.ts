// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asked what time it is, the agent answers with the reader's own clock (#300).
 *
 * Unit tests settle what the note says and where it sits. What they cannot
 * settle is that a real model reads it as the reader's time, works from it to
 * "tomorrow", keeps answering in the reader's language, and does not take it
 * for something the reader wrote. Each browser here runs in a zone of its own,
 * which is what the composer reports with every message.
 */
import { expect, test, type Browser, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';

/** How far the clock the reply states may sit from the moment it was asked. */
const SLACK_MINUTES = 3;

/**
 * A moment as a clock in one zone shows it.
 * @param at - The moment.
 * @param timeZone - The zone.
 * @returns The date as `YYYY-MM-DD` and the minutes since that midnight.
 */
function clockIn(at: Date, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Words that put a 12-hour time in the afternoon or evening. */
const AFTERNOON = /下午|晚上|傍晚|中午|午後|夜|오후|저녁|p\.?m\.?/i;

/** Words that put a 12-hour time between midnight and noon, where 12 is 0. */
const MORNING = /凌晨|半夜|深夜|早上|上午|午前|오전|새벽|a\.?m\.?/i;

/**
 * Whether a reply states a time within the slack of the expected one.
 * @param text - The reply.
 * @param expected - Minutes since midnight on the reader's clock.
 * @returns True when some hour and minute in it (`14:05`, `2点05分`, `2時5分`,
 * `2시 5분`), read on the 12-hour clock when a word for the part of the day
 * sits right before or after it, is close enough.
 */
function statesTimeNear(text: string, expected: number): boolean {
  return [
    ...text.matchAll(/([^\d\s]{0,3})\s*(?<!\d)(\d{1,2})\s*[:：点點時시]\s*(\d{1,2})(?!\d)\s*([^\d\s]{0,4})/g),
  ].some((m) => {
    const hour = Number(m[2]);
    const around = `${m[1] ?? ''} ${m[4] ?? ''}`;
    const hour24 = MORNING.test(around)
      ? hour % 12
      : hour < 12 && AFTERNOON.test(around)
        ? hour + 12
        : hour;
    const said = hour24 * 60 + Number(m[3]);
    const apart = Math.abs(said - expected);
    return Math.min(apart, 24 * 60 - apart) <= SLACK_MINUTES;
  });
}

/**
 * A signed-in page in the project, with the browser set to one zone.
 * @param browser - The browser.
 * @param timeZone - The zone the browser reports.
 * @returns The page.
 */
async function pageIn(browser: Browser, timeZone: string): Promise<Page> {
  const context = await browser.newContext({
    storageState: STATE_FILE.A,
    viewport: { width: 1500, height: 900 },
    timezoneId: timeZone,
  });
  const page = await context.newPage();
  await openSmokeProject(page);
  return page;
}

/**
 * Send one message in the open conversation and wait for the whole reply.
 * @param p - The signed-in page.
 * @param question - What the reader types.
 * @returns The reply's text.
 */
async function askHere(p: Page, question: string): Promise<string> {
  const before = await p.getByTestId('message-bubble').count();
  const composer = p.getByTestId('chat-composer-box');
  await composer.fill(question);
  await composer.press('Enter');
  await expect(p.getByTestId('message-bubble')).toHaveCount(before + 2, { timeout: 200_000 });
  await expect(p.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
  const reply = await p.getByTestId('message-bubble').last().innerText();
  // Kept on the report, so a pass can be read back against what was said.
  test.info().annotations.push({ type: 'reply', description: `${question} => ${reply}` });
  return reply;
}

/**
 * Start a fresh conversation.
 * @param p - The signed-in page.
 */
async function newConversation(p: Page): Promise<void> {
  await p.getByTestId('new-conversation').click();
  await expect(p.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
}

const ASK_THE_CLOCK =
  '现在几点？今天和明天分别是几号？请严格按这个格式回答：时间 HH:MM；今天 YYYY-MM-DD；明天 YYYY-MM-DD';

for (const timeZone of ['Asia/Shanghai', 'America/New_York']) {
  test(`gives today, tomorrow and the time in ${timeZone} @needs-model`, async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await pageIn(browser, timeZone);
    await newConversation(page);

    const asked = new Date();
    const text = await askHere(page, ASK_THE_CLOCK);

    const now = clockIn(asked, timeZone);
    const tomorrow = clockIn(new Date(asked.getTime() + 24 * 3600_000), timeZone);
    expect(text, `the reply: ${text}`).toContain(now.date);
    expect(text, `the reply: ${text}`).toContain(tomorrow.date);
    expect(statesTimeNear(text, now.minutes), `the reply: ${text}`).toBe(true);
    await page.context().close();
  });
}

test('reads the clock again when the same conversation goes on elsewhere @needs-model', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  const shanghai = await pageIn(browser, 'Asia/Shanghai');
  await newConversation(shanghai);
  await askHere(shanghai, '现在几点？只回答 HH:MM');
  await shanghai.context().close();

  // The project reopens on the conversation it was left on.
  // Fifteen or sixteen hours from Shanghai, by the season, so a repeat of the
  // earlier answer read on a 12-hour clock cannot pass for the new one.
  const losAngeles = await pageIn(browser, 'America/Los_Angeles');
  await expect(losAngeles.getByTestId('message-bubble')).toHaveCount(2, { timeout: 30_000 });
  const asked = new Date();
  const text = await askHere(losAngeles, '现在几点？只回答 HH:MM');

  expect(
    statesTimeNear(text, clockIn(asked, 'America/Los_Angeles').minutes),
    `the reply: ${text}`,
  ).toBe(true);
  await losAngeles.context().close();
});

test('answers from the clock, not as words the reader said, with a file attached @needs-model', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const page = await pageIn(browser, 'Asia/Shanghai');
  await newConversation(page);
  await page.getByTestId('chat-composer-file-input').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Shopping list: apples, bread, milk.'),
  });
  await expect(page.getByTestId('chat-composer-chips')).toContainText('notes.txt', {
    timeout: 20_000,
  });

  const asked = new Date();
  const text = await askHere(page, '现在几点？只回答 HH:MM');

  expect(statesTimeNear(text, clockIn(asked, 'Asia/Shanghai').minutes), `the reply: ${text}`).toBe(
    true,
  );
  expect(text, `the reply: ${text}`).not.toMatch(/local time when they sent|reader sent this message/i);
  await page.context().close();
});

test('keeps to Chinese for a very short Chinese question @needs-model', async ({ browser }) => {
  test.setTimeout(300_000);
  const page = await pageIn(browser, 'Asia/Shanghai');
  await newConversation(page);

  const asked = new Date();
  const text = await askHere(page, '几点了');

  expect(text, `the reply: ${text}`).toMatch(/[\u4e00-\u9fff]/);
  expect(statesTimeNear(text, clockIn(asked, 'Asia/Shanghai').minutes), `the reply: ${text}`).toBe(
    true,
  );
  await page.context().close();
});
