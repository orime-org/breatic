// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the agent says the canvas can do, measured against the live catalog.
 *
 * Unit tests settle what the two tools answer with. What they cannot settle
 * is whether a real turn reaches them and uses what comes back: the tools
 * have to be in the turn's tool set, their answers have to survive the SDK's
 * conversion into something the model reads, and the model has to name a mode
 * and a model out of that rather than out of its own memory.
 *
 * So the assertion is grounding: every generation model this deployment can
 * serve is fetched from the same catalog the panel reads, and the reply has
 * to name one of them. A build where the tools never reached the turn answers
 * with a plausible model name that is not in this catalog, or with none.
 *
 * The turn is real, so the model decides how to answer. A run where it
 * replies in prose without naming anything is reported as such rather than
 * passed.
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

/**
 * Every image model name this deployment can currently serve.
 *
 * Read through the signed-in page so it is the catalog this turn was served
 * from, keys and all, rather than what the yaml on disk declares.
 * Both names of each: the id a node stores and the name the picker shows.
 * The answer carries both and a reply names whichever reads better to the
 * person asking, so grounding on the id alone calls a grounded reply wrong.
 * @param p - The signed-in page.
 * @returns Every name a grounded reply can use.
 */
async function servableImageModels(p: Page): Promise<string[]> {
  const catalog = await p.evaluate(async () => {
    const answer = await fetch('/api/v1/models', { credentials: 'include' });
    return (await answer.json()) as {
      data?: { image?: { name: string; display_name: string }[] };
    };
  });
  return (catalog.data?.image ?? []).flatMap((model) => [model.name, model.display_name]);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openProject(page);
});

test.afterAll(async () => {
  await page.close();
});

test('names a model this deployment can actually serve', async () => {
  // A real turn: the wait is on a model, and on two tool calls before it.
  test.setTimeout(180_000);
  const composer = page.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  const servable = await servableImageModels(page);
  expect(servable.length, 'the deployment serves some image model').toBeGreaterThan(0);

  // Its own conversation, so what this measures is what this turn produced.
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  // One question with nothing left to settle. A prompt that leaves a choice
  // open is answered with `ask_user`, which ends the turn before the second
  // tool is ever reached -- a real answer to a real question, and not the
  // sequence this case is about.
  await composer.fill(
    'List every model I can use for image-to-image on an image node, with what each costs. Do not ask me anything -- just list them.',
  );
  await composer.press('Enter');

  // The reply settles when the composer takes input again.
  const bubbles = page.getByTestId('message-bubble');
  await expect(bubbles).toHaveCount(2, { timeout: 150_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 150_000 });

  // What the turn actually did, read off the stored conversation. The running
  // line names each tool while it runs, but it is gone by the time the reply
  // lands; the stored parts are what a finished turn can still be read off.
  const used = await page.evaluate(async () => {
    const list = await (
      await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })
    ).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (
      await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })
    ).json();
    const messages = (read?.data?.messages ?? []) as { parts?: { type?: string }[] }[];
    // Each tool use is stored as its own part type, `tool-<name>`, which is
    // the SDK's naming for a typed tool part.
    return messages
      .flatMap((m) => m.parts ?? [])
      .map((part) => part.type ?? '')
      .filter((type) => type.startsWith('tool-'))
      .map((type) => type.slice('tool-'.length));
  });


  expect(used, 'the turn asked what the canvas can do').toContain(
    'get_canvas_capabilities',
  );
  expect(used, 'the turn asked which models back the mode it chose').toContain(
    'list_generation_models',
  );

  const reply = (await bubbles.last().innerText()).toLowerCase();
  const named = servable.filter((name) => reply.includes(name.toLowerCase()));
  expect(
    named,
    `the reply names no model this deployment serves. Servable: ${servable.join(', ')}. Reply: ${reply}`,
  ).not.toHaveLength(0);

  // How many detail calls one turn makes decides whether asking twice is
  // cheaper than injecting the whole catalog. Recorded rather than bounded:
  // a ceiling here would be a rule nobody agreed to.
  const details = used.filter((name) => name === 'list_generation_models').length;
  // eslint-disable-next-line no-console -- the measurement is the point of this line
  console.log(`tools used this turn: ${used.join(', ')} (detail calls: ${details})`);
});
