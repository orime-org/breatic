// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the agent puts into a judgement call, measured on a real turn.
 *
 * Unit tests settle what the tool sends and what it does with the answer.
 * What they cannot settle is the half the model owns: it composes the whole
 * request -- the state, the question shapes, the wording of every option --
 * and a call is only worth its round trip if that material is there.
 *
 * So the assertion is on the request itself, not on the fact of the call.
 * The measured difference is large: the same claims judged against a bare
 * state came back in the 0.07-0.52 band and against the material at 0.98,
 * and both calls answer HTTP 200 with a well-formed body. A check that only
 * asked whether the tool ran would pass either way.
 *
 * The turn is real, so the model decides how to answer. The prompt leaves it
 * no one to ask, because a turn that reaches `ask_user` ends before it gets
 * here -- a real answer to a real question, and not the sequence this case is
 * about.
 */
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';

let page: Page;

/** What the reader says, held here so the state can be measured against it. */
const PROMPT =
  'I want a thirty second product video. Do not ask me anything -- work out for ' +
  'yourself which of the ways you can build one suits this best, and tell me how ' +
  'likely each of them is to be the right call.';

/** One tool call as the finished conversation stores it. */
interface StoredCall {
  readonly name: string;
  readonly input: unknown;
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
      parts?: { type?: string; input?: unknown }[];
    }[];
    // Each tool use is stored as its own part type, `tool-<name>`, which is
    // the SDK's naming for a typed tool part.
    return messages
      .flatMap((m) => m.parts ?? [])
      .filter((part) => (part.type ?? '').startsWith('tool-'))
      .map((part) => ({
        name: (part.type ?? '').slice('tool-'.length),
        input: part.input,
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

test('asks for a judgement with the material attached @needs-model', async () => {
  const composer = page.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // Its own conversation, so what this measures is what this turn produced.
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  await composer.fill(PROMPT);
  await composer.press('Enter');

  // The reply settles when the composer takes input again.
  const bubbles = page.getByTestId('message-bubble');
  await expect(bubbles).toHaveCount(2, { timeout: 150_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 150_000 });

  const calls = await callsOfLatestConversation(page);
  const judged = calls.filter((call) => call.name === 'judge_likelihood');
  expect(
    judged,
    `the turn asked for a judgement. Tools used: ${calls.map((c) => c.name).join(', ')}`,
  ).not.toHaveLength(0);

  const sent = judged[0]?.input as {
    state?: unknown;
    questions?: Record<string, { criteria?: unknown }>;
  };

  // The state is what the answer is judged against, and a thin one is the
  // failure this case exists for: it returns a well-formed answer made of
  // noise. So what is measured is the material that is not the prompt --
  // subtracting lengths would pass a state made of the prompt twice over.
  const stateText = JSON.stringify(sent.state ?? '');
  const beyondPrompt = stateText.split(PROMPT).join('');
  expect(
    beyondPrompt.length,
    `the state carries material of its own, not the prompt back: ${stateText}`,
  ).toBeGreaterThan(200);

  const asked = Object.values(sent.questions ?? {});
  expect(asked, 'at least one question').not.toHaveLength(0);

  // Options written as sentences rather than bare labels. A label names the
  // option; what it is is what Jev judges.
  const optionText = asked.flatMap((question) => {
    const criteria = question.criteria;
    return typeof criteria === 'object' && criteria !== null && !Array.isArray(criteria)
      ? Object.values(criteria as Record<string, string>)
      : [];
  });
  // Asserted rather than guarded, because the guard would pass a turn that
  // asked nothing with options at all -- and the prompt asks for each way to
  // be weighed, which is what an option question is. A turn that answered it
  // some other way is worth stopping on, not stepping over.
  expect(
    optionText,
    `the turn put its options to the tool: ${JSON.stringify(asked)}`,
  ).not.toHaveLength(0);
  // The floor, not the ceiling: one written-out option among bare labels is
  // the shape this is here to catch.
  const shortest = Math.min(...optionText.map((text) => text.length));
  expect(
    shortest,
    `options are written out, not labelled: ${optionText.join(' | ')}`,
  ).toBeGreaterThan(25);

  // eslint-disable-next-line no-console -- the measurement is the point of this line
  console.log(
    `judgement calls: ${String(judged.length)}, state ${String(stateText.length)} chars ` +
      `over a ${String(PROMPT.length)}-char prompt, ${String(asked.length)} question(s), ` +
      `${String(optionText.length)} option(s)`,
  );
});
