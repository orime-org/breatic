// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A judgement call, once the agent makes one, comes back answered.
 *
 * Unit tests settle what the tool sends and what it does with the answer,
 * against a double. This runs a real turn against the real endpoint, so what
 * it settles is the wiring end to end: the call the model composed reaches the
 * endpoint and the answer reaches the conversation in one of the three shapes.
 *
 * Whether the agent reaches for the tool, and how it words the state and the
 * options, is the agent's own judgement. The prompt asks for the odds, and a
 * turn that answered some other way is a reasonable turn; so the case opens up
 * to a few fresh conversations and holds the first call it gets, and prints how
 * much material that call carried.
 */
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';

let page: Page;

/** What the reader says: a question with no one to ask back and odds asked for. */
const PROMPT =
  'I want a thirty second product video. Do not ask me anything -- work out for ' +
  'yourself which of the ways you can build one suits this best, and tell me how ' +
  'likely each of them is to be the right call.';

/** One tool call as the finished conversation stores it. */
interface StoredCall {
  readonly name: string;
  readonly input: unknown;
  /** `output-available`, `output-error` or `input-available`. */
  readonly state: string;
  readonly output: unknown;
}

/**
 * Every tool call this conversation made, with what was sent to each.
 * @param p - The signed-in page.
 * @returns The calls, in the order they were stored.
 */
async function callsOfLatestConversation(p: Page): Promise<StoredCall[]> {
  return p.evaluate(async () => {
    const list = await (
      await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })
    ).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (
      await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })
    ).json();
    const messages = (read?.data?.messages ?? []) as {
      parts?: { type?: string; input?: unknown; state?: string; output?: unknown }[];
    }[];
    // Each tool use is stored as its own part type, `tool-<name>`, which is
    // the SDK's naming for a typed tool part.
    return messages
      .flatMap((m) => m.parts ?? [])
      .filter((part) => (part.type ?? '').startsWith('tool-'))
      .map((part) => ({
        name: (part.type ?? '').slice('tool-'.length),
        input: part.input,
        state: (part as { state?: string }).state ?? '',
        output: (part as { output?: unknown }).output,
      }));
  });
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({
    storageState: STATE_FILE.A,
    viewport: { width: 1400, height: 900 },
  });
  await openSmokeProject(page);
});

test.afterEach(async () => {
  await page.close();
});

/** How many fresh conversations to open before the case gives up on a call. */
const ATTEMPTS = 3;

/**
 * Send the prompt in a fresh conversation and read back what it called.
 * @param p - The signed-in page.
 * @returns Every tool call that turn made.
 */
async function runOneTurn(p: Page): Promise<StoredCall[]> {
  const composer = p.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await p.getByTestId('new-conversation').click();
  await expect(p.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  await composer.fill(PROMPT);
  await composer.press('Enter');
  // The reply settles when the composer takes input again. A step of this
  // model was measured at 45-114s with thinking on.
  await expect(p.getByTestId('message-bubble')).toHaveCount(2, { timeout: 200_000 });
  await expect(p.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
  return callsOfLatestConversation(p);
}

test('a judgement call comes back answered @needs-model', async () => {
  test.setTimeout(ATTEMPTS * 240_000);

  let judged: StoredCall | undefined;
  const used: string[] = [];
  for (let attempt = 0; attempt < ATTEMPTS && judged === undefined; attempt += 1) {
    const calls = await runOneTurn(page);
    used.push(calls.map((c) => c.name).join(', ') || '(none)');
    judged = calls.find((call) => call.name === 'judge_likelihood');
  }
  expect(judged, `no turn of ${String(ATTEMPTS)} made a judgement call: ${used.join(' | ')}`).toBeDefined();

  // `message-part-mapping.ts:159-163` puts `input` on the base of all three
  // states, so a call that came back 401, 422 or unreadable carries a full
  // request and reads here exactly like one that worked. What settles whether
  // the endpoint took it is the answer half.
  expect(judged?.state, `the judgement came back: ${JSON.stringify(judged?.output)}`).toBe(
    'output-available',
  );
  const answered =
    (judged?.output as { answers?: Record<string, { type?: string }> })?.answers ?? {};
  expect(Object.keys(answered), 'at least one key answered').not.toHaveLength(0);
  for (const [key, answer] of Object.entries(answered)) {
    expect(['noul', 'choice', 'score'], `${key} came back one of the three shapes`).toContain(
      answer.type,
    );
  }

  const sent = judged?.input as { state?: unknown; questions?: Record<string, unknown> };
  // eslint-disable-next-line no-console -- the measurement is the point of this line
  console.log(
    `turns: ${used.join(' | ')}; state ${String(JSON.stringify(sent.state ?? '').length)} chars, ` +
      `${String(Object.keys(sent.questions ?? {}).length)} question(s), ` +
      `${String(Object.keys(answered).length)} answered`,
  );
});
