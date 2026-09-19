// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the audio Generate panel looks like, measured in a browser (#1960 PR1).
 *
 * Each case here pins one thing the panel itself does — a pointer target's
 * size, how many rows a list stands, a ring drawn outside a button, which
 * boxes a mode puts up and what the figure beside them says. None of them
 * walks a generation attempt through to its answer; those are in
 * `tests/smoke/audio-generate-panel.spec.ts`, and both files take their
 * opening and their two moves from `tests/helpers/audio-panel.ts`.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:visual
 */
import { test, expect } from 'playwright/test';

import { openGenerate, panCanvasDown, seedNode } from '../helpers/audio-panel';

test('the stability tick labels are a pointer target the standard accepts', async ({ page }) => {
  // WCAG 2.2 SC 2.5.8 (AA) takes 24x24 CSS px, or 24px-diameter circles on
  // each undersized target that do not intersect. The three ticks sit 6px
  // under a 12px slider thumb, so the spacing exception cannot rescue them —
  // measured at 20.32px between the two circles' centres before this case
  // existed. A pointer aimed at "Natural" that lands 4px high drags the value
  // instead.
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio');
  await openGenerate(nodeId);

  await page.getByTestId('generate-audio-params-trigger').click();
  const ticks = page.locator('[data-testid^="generate-audio-stability-stop-"]');
  await expect(ticks.first()).toBeVisible({ timeout: 10_000 });

  const count = await ticks.count();
  expect(count).toBe(3);
  for (let i = 0; i < count; i += 1) {
    // In CSS pixels, the unit the criterion is written in. A bounding box
    // would answer in screen pixels, and this panel lives on a canvas the
    // reader zooms — at 96% every target measures under its own size, which
    // says nothing about the design.
    const height = await ticks.nth(i).evaluate((el) => parseFloat(getComputedStyle(el).height));
    expect(height, `tick ${i} height`).toBeGreaterThanOrEqual(24);
  }
});

test('the voice list stands the five rows it is sized for @needs-tts', async ({ page }) => {
  // The height constant counts five rows of content, and the box it is set on
  // carries its own padding — which `border-box` takes out of that same
  // number, leaving the fifth row 8px short of a row. Measured against the
  // rows themselves: the fifth one is either a whole row tall inside the
  // scroller, or it is not there.
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio');
  await openGenerate(nodeId);

  await page.getByTestId('generate-voice-trigger').click();
  const body = page.getByTestId('generate-voice-list-body');
  await expect(body).toBeVisible({ timeout: 20_000 });
  const options = page.locator('[data-testid^="generate-voice-option-"]');
  await expect(options.first()).toBeVisible({ timeout: 20_000 });
  // How many rows the vendor's catalogue holds is not something a tag can ask
  // for, so the case says so and stops. The smoke suite bans this; a measured
  // one against a catalogue that is too short has nothing to measure.
  if ((await options.count()) < 5) test.skip(true, 'deployment serves under five voices');

  const room = await body.evaluate((el) => {
    const cs = getComputedStyle(el);
    return (
      el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBlockEnd || cs.paddingBottom)
    );
  });
  const fifthBottom = await options.nth(4).evaluate((el) => el.getBoundingClientRect().bottom);
  const contentTop = await body.evaluate(
    (el) => el.getBoundingClientRect().top + parseFloat(getComputedStyle(el).paddingTop),
  );
  expect(fifthBottom - contentTop).toBeLessThanOrEqual(room + 0.5);
});

test('the voice playing is marked by a ring drawn outside its button @needs-tts @needs-internet', async ({ page }) => {
  // Design §6.3 (user 2026-09-01): the sample button gets a turning ring on
  // its outside — an `inset:-3px` pseudo-element that leaves the 24x24 target
  // alone — and it holds still under `prefers-reduced-motion`. Swapping the
  // glyph is the whole of what the row said before this case existed.
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio');
  await openGenerate(nodeId);

  await page.getByTestId('generate-voice-trigger').click();
  const samples = page.locator('[data-testid^="generate-voice-sample-"]');
  await expect(page.locator('[data-testid^="generate-voice-option-"]').first()).toBeVisible({
    timeout: 20_000,
  });
  // How many rows the vendor's catalogue holds is not something a tag can ask
  // for, so the case says so and stops. The smoke suite bans this; a measured
  // one against a catalogue that is too short has nothing to measure.
  if ((await samples.count()) === 0) test.skip(true, 'this deployment previews nothing');

  const button = samples.first();
  const boxBefore = await button.boundingBox();
  await button.click();

  await expect
    .poll(
      async () =>
        button.evaluate((el) => {
          const ring = getComputedStyle(el, '::after');
          return {
            drawn: ring.content !== 'none' && parseFloat(ring.borderTopWidth) > 0,
            outside: parseFloat(ring.top) < 0,
            round: ring.borderTopLeftRadius,
          };
        }),
      { timeout: 10_000 },
    )
    .toMatchObject({ drawn: true, outside: true });

  // The ring is painted, not laid out: the target keeps the size the standard
  // was measured against.
  const boxAfter = await button.boundingBox();
  expect(boxAfter!.height).toBe(boxBefore!.height);
  expect(boxAfter!.width).toBe(boxBefore!.width);
});

test('sound effects: a length picker, and a credit figure that follows it', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio', undefined, 250);
  await openGenerate(nodeId);

  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-sfx').click();

  // The speech controls go with the mode: nothing here picks a voice, and
  // nothing here clones one.
  await expect(page.getByTestId('generate-audio-params-trigger')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('generate-voice-trigger')).toHaveCount(0);
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toHaveCount(0);

  // The box asks for a sound rather than for lines to speak. Tiptap's
  // Placeholder extension puts the text on the empty paragraph inside the
  // editor, and a css rule draws it from there.
  await expect(page.getByTestId('generate-prompt-editor').locator('[data-placeholder]').first()).toHaveAttribute(
    'data-placeholder',
    /sound/i,
  );

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('glass shattering, then footsteps over the shards');

  // Five seconds is what the model defaults to, and $0.002 a second at
  // 1 credit = 1 cent puts that at one credit.
  await expect(page.getByTestId('generate-audio-rate')).toHaveText('1', {
    timeout: 10_000,
  });

  // Thirty seconds costs six, and the figure follows the picker rather than
  // the prompt — which has not changed.
  await page.getByTestId('generate-audio-params-trigger').click();
  await page.getByTestId('generate-audio-duration-option-30').click();
  await expect(page.getByTestId('generate-audio-rate')).toHaveText('6', {
    timeout: 10_000,
  });

  // The longest preset the gateway takes, at the price the rate states.
  await page.getByTestId('generate-audio-duration-option-180').click();
  await expect(page.getByTestId('generate-audio-rate')).toHaveText('36', {
    timeout: 10_000,
  });
});

test('text to music: two boxes, a switch, and an empty lyrics box refuses the submit', async ({ page }) => {
  test.setTimeout(90_000);
  const nodeId = crypto.randomUUID();
  // Panned up first, because this panel carries two editors and stands 396px
  // against the suite's 720px window — measured 2026-09-05, against 234px on
  // the sound-effect mode. Left of the origin for the reason the other cases
  // are: the minimap in the bottom-right corner takes clicks meant for it.
  await seedNode(nodeId, 'audio', undefined, -50);
  await panCanvasDown(250);
  await openGenerate(nodeId);

  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-t2m').click();

  // The mode's own model, and its flat price. minimax/music-3.0 bills $0.15 a
  // call whatever the brief says, so the figure holds at 15 while text is
  // typed. The three speech models move with the prompt and the sound-effect
  // model moves with the length picker; this is the first on the panel that
  // moves with neither.
  await expect(page.getByTestId('generate-audio-rate')).toHaveText('15', {
    timeout: 15_000,
  });

  // A style box and a lyrics box, each carrying a word saying which it is.
  const style = page.getByTestId('generate-prompt-editor');
  const lyrics = page.getByTestId('generate-lyrics-editor');
  await expect(style).toBeVisible();
  await expect(lyrics).toBeVisible();
  await expect(style.locator('[data-placeholder]').first()).toHaveAttribute(
    'data-placeholder',
    /genre|mood|instrument/i,
  );
  await expect(lyrics.locator('[data-placeholder]').first()).toHaveAttribute('data-placeholder', /lyric/i);

  // The style box opens at half the lyrics box's height (user 2026-09-05): a
  // brief is a line or two of words, and the words to sing are a whole song.
  // Both grow as they are typed into and cap at the same ceiling; what differs
  // is where each one starts.
  const heights = await page.evaluate(() => {
    const h = (id: string) =>
      Math.round(document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().height ?? 0);
    return { style: h('generate-prompt-editor'), lyrics: h('generate-lyrics-editor') };
  });
  expect(heights.lyrics).toBeGreaterThan(0);
  expect(heights.style).toBeGreaterThan(0);
  // 3.25rem against 6.5rem, each plus a 1px border either side: 54 against
  // 106, a ratio of 0.509. A narrow band rather than the two numbers, because
  // both floors are stated in rem and the ratio is what was asked for — but
  // narrow enough that a floor which is not half fails it. The first band
  // written here was 0.4 to 0.62, which accepted the 0.566 the arithmetic was
  // then producing.
  expect(heights.style / heights.lyrics).toBeGreaterThan(0.48);
  expect(heights.style / heights.lyrics).toBeLessThan(0.54);

  // Nothing here picks a voice, clones one, or collects a reference: the mode
  // states its slots and this one states none.
  await expect(page.getByTestId('generate-voice-trigger')).toHaveCount(0);
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toHaveCount(0);
  await expect(page.getByTestId('generate-audio-tool-music-song')).toHaveCount(0);

  // Neither box filled: the click names the one on top, and it names it by
  // what the screen calls it. Nothing on this panel is labelled "prompt", and
  // the box that IS labelled is the other one.
  await expect(page.getByTestId('generate-audio-execute')).toBeEnabled();
  await page.getByTestId('generate-audio-execute').click();
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('Write the style first', { timeout: 10_000 });

  // A brief alone leaves the button live and the click says what is missing —
  // the gateway refuses this model without lyrics, so the panel says so first
  // rather than letting the user watch a generation start and fail.
  await style.click();
  await page.keyboard.type('warm indie folk, fingerpicked guitar, 90 BPM');
  await expect(page.getByTestId('generate-audio-execute')).toBeEnabled();
  await page.getByTestId('generate-audio-execute').click();
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('Write the lyrics first', {
    timeout: 10_000,
  });

  // Both boxes read as typable. The rule that says so lives on a class the
  // panel owns (`index.css`); it used to key on the prompt editor's test id,
  // which is a prop now, so the lyrics box matched nothing and showed an arrow.
  for (const id of ['generate-prompt-editor', 'generate-lyrics-editor']) {
    await expect
      .poll(() => page.locator(`[data-testid="${id}"] .ProseMirror`).evaluate((el) => getComputedStyle(el).cursor), {
        timeout: 10_000,
      })
      .toBe('text');
  }

  // The pill names the state it is in, the way every other pill on this row
  // prints its current value. This model declares one param and nothing else,
  // so this string is the whole pill face.
  const pill = page.getByTestId('generate-audio-params-trigger');
  await expect(pill).toContainText('With vocals', { timeout: 10_000 });

  await pill.click();
  const instrumental = page.getByTestId('generate-audio-is_instrumental-toggle');
  await expect(instrumental).toBeVisible({ timeout: 10_000 });
  await expect(instrumental).toHaveAttribute('aria-checked', 'false');
  await instrumental.click();
  await expect(instrumental).toHaveAttribute('aria-checked', 'true', {
    timeout: 10_000,
  });
  await expect(pill).toContainText('Instrumental only', { timeout: 10_000 });
  // The panel says so too: with no vocals there are no words to write, so the
  // box is gone rather than standing there refusing typing (user 2026-09-06).
  // The switch is thrown while the editor is already up, which is the path the
  // unit suite cannot walk — it is a running editor that has to go, not a
  // fresh render built from the new state.
  await expect(page.getByTestId('generate-lyrics-editor')).toHaveCount(0, {
    timeout: 10_000,
  });
  // The box that stays keeps its name: this mode still asks for a style brief,
  // and losing the word at the moment the second box leaves would read as the
  // panel going back to asking for one plain prompt.
  await expect(page.getByText('Style', { exact: true })).toBeVisible();
  await expect(page.getByText('Lyrics', { exact: true })).toHaveCount(0);
  // Off again, so the case leaves the node the way it found it.
  await instrumental.click();
  await expect(instrumental).toHaveAttribute('aria-checked', 'false', {
    timeout: 10_000,
  });
  await expect(pill).toContainText('With vocals', { timeout: 10_000 });
  await expect(page.getByTestId('generate-lyrics-editor').locator('[data-placeholder]')).toHaveAttribute(
    'data-placeholder',
    'Write the lyrics',
    { timeout: 10_000 },
  );
  await page.keyboard.press('Escape');
});
