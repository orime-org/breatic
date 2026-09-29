// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Trying to generate audio on a canvas node, end to end (#1960 PR1).
 *
 * What no jsdom test reaches: the voice list comes from a real endpoint, the
 * panel opens off a real context menu on a real canvas node, and
 * the submit gate is judged against a prompt the collaborative editor
 * serialized rather than a string a test handed it.
 *
 * The cases that measure the panel rather than walk an attempt are in
 * `tests/visual/audio-generate-panel.spec.ts`; both files take their opening
 * and their two moves from `tests/helpers/audio-panel.ts`.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect } from 'playwright/test';

import { openGenerate, seedNode, registerCanvasStage, voiceRowCount } from '../helpers/audio-panel';

registerCanvasStage();

// One node, one panel, one continuous session — which is also how a person
// uses it: open it, look at it, adjust it, submit. Splitting these into a test
// each would reopen the panel three times and say nothing more.
test('the panel opens, offers what the model declares, and stands the first voice in for an unpicked one', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio');
  await openGenerate(nodeId);

  await expect(page.getByTestId('generate-audio-mode-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-model-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-audio-settings-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-audio-tool-reference')).toBeVisible();
  // The rate, not a total: the model bills by how much text is sent.
  await expect(page.getByTestId('generate-audio-rate')).toBeVisible();

  // The default model declares one range, its speaking speed.
  await page.getByTestId('generate-audio-settings-trigger').click();
  await expect(page.getByRole('slider', { name: /speed/i })).toBeVisible();
  await page.keyboard.press('Escape');

  // Another model, other params: ElevenLabs declares two 0-1 ranges, and
  // stability carries the three positions ElevenLabs names on that scale.
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-elevenlabs-v3').click();
  await page.getByTestId('generate-audio-settings-trigger').click();
  await expect(page.getByRole('slider', { name: /speed/i })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: /stability/i })).toBeVisible();
  await expect(page.getByRole('slider', { name: /similarity/i })).toBeVisible();
  await expect(page.getByTestId('generate-audio-stability-stop-0')).toBeVisible();
  await expect(page.getByTestId('generate-audio-stability-stop-0.5')).toBeVisible();
  await expect(page.getByTestId('generate-audio-stability-stop-1')).toBeVisible();
  // Escape closes the top layer first, and a slider's tooltip can be it.
  const voiceRow = page.getByTestId('generate-audio-row-voice_id');
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(voiceRow).toBeHidden({ timeout: 500 });
  }).toPass({ timeout: 5_000 });

  // With no voice picked, the first voice of the model's list is the voice
  // (user 2026-09-29): the pill names it and the list marks it chosen.
  await page.getByTestId('generate-audio-settings-trigger').click();
  await voiceRow.click();
  const first = page.locator('[data-testid^="generate-voice-option-"]').first();
  await expect(first).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  const firstName = (await first.innerText()).split('\n')[0];
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('generate-audio-settings-trigger')).toContainText(firstName);
});

test('text past the model’s limit is refused before anything is sent', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio');
  await openGenerate(nodeId);

  // The default model, realtime-tts-2, takes 2,000 characters (its catalog
  // entry's `max_input_chars`). Inserted in one go rather than keystroke by
  // keystroke: what is under test is the length, not the typing.
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.insertText('x'.repeat(2001));

  await page.getByTestId('generate-audio-execute').click();

  // Named, not merely refused: the reader has to know how much to cut.
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('2,000', { timeout: 10_000 });
});

test('the voice list matches the deployment it is served from, and a pick survives a reopen @needs-tts', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio');
  await openGenerate(nodeId);

  await page.getByTestId('generate-audio-settings-trigger').click();
  await page.getByTestId('generate-audio-row-voice_id').click();
  const options = page.locator('[data-testid^="generate-voice-option-"]');
  await expect(options.first()).toBeVisible({ timeout: 20_000 });

  // The list is the model's own catalog entry (#2156): WaveSpeed has no voice
  // endpoint to ask. A row previews when its entry carries a sample, so the
  // invariant is that the entry is served whole — every row previews or none
  // does — rather than a count this box happens to hold.
  const rows = await options.count();
  const samples = await page.locator('[data-testid^="generate-voice-sample-"]').count();
  expect(rows).toBeGreaterThan(0);
  expect([0, rows]).toContain(samples);

  // The second row: the first is what an untouched node already stands on.
  const chosen = (await options.nth(1).innerText()).split('\n')[0];
  const saysChosen = new RegExp(chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  await options.nth(1).click();
  await expect(page.getByTestId('generate-audio-settings-trigger')).toHaveText(saysChosen);

  // The pick is a parameter ON THE NODE, not panel state. Going to a second
  // audio node and back reads it off the document twice over: the panel that
  // opens on the untouched node must NOT show the first one's voice, and the
  // one that reopens on the first must still show it.
  const otherId = crypto.randomUUID();
  await seedNode(otherId, 'audio');
  await openGenerate(otherId);
  await expect(page.getByTestId('generate-audio-settings-trigger')).not.toHaveText(saysChosen);

  await openGenerate(nodeId);
  await expect(page.getByTestId('generate-audio-settings-trigger')).toHaveText(saysChosen);
});

test('an audio node with a produced asset can be picked into the talking-head driving slot', async ({ page }) => {
  // The slot's candidate rule is the node's TYPE and whether it holds an asset
  // (`CanvasSpace.tsx:3991`), not how the asset got there — so a seeded one
  // exercises the same path a generated one takes, without a vendor round trip.
  // The video node goes on the LEFT of the pair. A Space this case made for
  // itself frames what is in it, so the pair ends up centred whatever
  // coordinates they carry; the video panel is wide, and hanging below the
  // right-hand node it reaches the minimap in the bottom-right corner, which
  // sits above it and takes the clicks meant for the slot row.
  const audioId = crypto.randomUUID();
  const videoId = crypto.randomUUID();
  await seedNode(videoId, 'video', undefined, -350);
  await seedNode(audioId, 'audio', 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0U=', -50);

  await openGenerate(videoId, 'generate-video-mode-trigger');
  await page.getByTestId('generate-video-mode-trigger').click();
  await page.getByTestId('generate-video-mode-talking-head').click();

  await page.getByTestId('generate-video-tool-driving-audio').click();
  await page.locator(`.react-flow__node[data-id="${audioId}"]`).click();

  // The clear button, not the thumbnail: a filled slot draws a thumbnail from
  // the pick's cover, and an audio node carries no poster — the toolbar covers
  // the button with the audio icon instead (the `storesCover` comment on
  // `video-slots.ts`'s drivingAudio entry says why). The clear button is what
  // says the slot is holding something whatever the kind is.
  await expect(page.getByTestId('generate-video-driving-audio-clear')).toBeVisible({ timeout: 10_000 });
});

// One node, one panel, one session again: switching to voice cloning, picking
// the recording to clone, and submitting are the steps of a single use, and the
// state each leaves is what the next one reads.
test('voice cloning swaps the voice picker for a slot, and refuses a submit with nothing picked', async ({ page }) => {
  // The candidate rule is the node's TYPE and whether it holds an asset
  // (`CanvasSpace.tsx:3991`), so a seeded audio node exercises the same path a
  // generated one takes without a vendor round trip. Seeded left of the origin
  // for the same reason the talking-head case is: the minimap in the
  // bottom-right corner sits above the panel and takes clicks meant for it.
  const sourceId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  await seedNode(sourceId, 'audio', 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0U=', -350);
  await seedNode(nodeId, 'audio', undefined, -50);
  await openGenerate(nodeId);

  // Text to speech first: the picker is there and the slot is not.
  expect(await voiceRowCount(page)).toBe(1);
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toHaveCount(0);

  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-voice-clone').click();

  // They swap. qwen3 declares no voice param, so a picker would offer a choice
  // that reaches nothing; what it needs instead is a recording to clone.
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toBeVisible({
    timeout: 15_000,
  });
  expect(await voiceRowCount(page)).toBe(0);
  // Reference stays in both modes: an audio node's edges take text, and a line
  // already written on the canvas is prompt material whichever model runs.
  await expect(page.getByTestId('generate-audio-tool-reference')).toBeVisible();

  // The button stays clickable with the slot empty, and says what is missing —
  // the repo's stated policy for a condition the user can act on
  // (`generate-guards.ts:160-166`).
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('Say this in my voice.');
  await expect(page.getByTestId('generate-audio-execute')).toBeEnabled();
  await page.getByTestId('generate-audio-execute').click();
  // Named, not merely present: every other refusal on this panel also raises a
  // toast, so asserting that one appeared says nothing about which condition
  // the gate judged.
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('Pick a voice sample first', {
    timeout: 10_000,
  });

  // Picking fills it. The clear badge, not a thumbnail: an audio node carries
  // no poster, so the button shows the slot's icon (#1946) — the badge is what
  // says it holds something whatever the kind.
  await page.getByTestId('generate-audio-tool-ref-audio').click();
  await page.locator(`.react-flow__node[data-id="${sourceId}"]`).click();
  await expect(page.getByTestId('generate-audio-ref-audio-clear')).toBeVisible({
    timeout: 10_000,
  });

  // The pick is a value ON THE NODE, so switching back to text to speech and
  // returning finds it still there — and the text-to-speech pass in between shows
  // the picker again rather than a slot holding it.
  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-tts').click();
  await expect(page.getByTestId('generate-audio-settings-trigger')).toBeVisible({
    timeout: 15_000,
  });
  expect(await voiceRowCount(page)).toBe(1);
  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-voice-clone').click();
  await expect(page.getByTestId('generate-audio-ref-audio-clear')).toBeVisible({
    timeout: 15_000,
  });
});

test('reference to music: three slots, and any one of them satisfies the gate', async ({ page }) => {
  // Seeded left of the origin: the minimap in the bottom-right corner sits
  // above the panel and takes clicks meant for it (#2051).
  const sourceId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  await seedNode(sourceId, 'audio', 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0U=', -350, -240);
  await seedNode(nodeId, 'audio', undefined, -50, -240);
  await openGenerate(nodeId);

  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-a2m').click();

  // Three slots, not one: the model takes a reference song, a melody and a
  // voice to sing with, any of them on its own. None of them is the voice
  // sample the cloning mode asks for.
  await expect(page.getByTestId('generate-audio-tool-music-song')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('generate-audio-tool-music-melody')).toBeVisible();
  await expect(page.getByTestId('generate-audio-tool-music-vocal')).toBeVisible();
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toHaveCount(0);

  // $0.225 a call is 22.5 credits, part-credits kept (`formatCredits`).
  // Nothing is picked yet, so no upload or clone step is priced in.
  await expect(page.getByTestId('generate-audio-rate')).toHaveText('22.5', {
    timeout: 15_000,
  });

  // With both boxes filled and no slot picked, the click says a reference is
  // missing and names the three this mode offers. The lyrics go in first
  // because they are refused ahead of the slots — this model demands them too.
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('same mood, slower');
  await page.getByTestId('generate-lyrics-editor').click();
  await page.keyboard.type('same road home');
  await page.getByTestId('generate-audio-execute').click();
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('Pick a song, melody or vocals', {
    timeout: 10_000,
  });

  // The middle slot alone is enough: the vendor takes whichever are given, and
  // a gate demanding a particular one would grey the button out for a user who
  // filled another.
  await page.getByTestId('generate-audio-tool-music-melody').click();
  await page.locator(`.react-flow__node[data-id="${sourceId}"]`).click();
  await expect(page.getByTestId('generate-audio-music-melody-clear')).toBeVisible({ timeout: 10_000 });

  // Stopping here rather than clicking submit again: with the gate satisfied
  // the click sends a real task to the vendor and spends what this model
  // bills. Which of the three satisfies it is pinned by the unit case
  // that walks all three (`generate-guards.test.ts`); what only a real run
  // reaches is the wiring above — the slot renders, the pick lands on the node
  // and the toolbar shows it.
  //
  // The pick is a value ON THE NODE, so a trip through another mode and back
  // finds it still there, and the mode in between offers its own slots rather
  // than these.
  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-voice-clone').click();
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('generate-audio-tool-music-melody')).toHaveCount(0);

  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-a2m').click();
  await expect(page.getByTestId('generate-audio-music-melody-clear')).toBeVisible({ timeout: 15_000 });
});

test('Gemini keeps its reading mode, language and speakers in the settings pill', async ({ page }) => {
  // Design §16: the pill opens a first panel over it, a row there opens a
  // second panel to its right, and the rows read reading mode, language, voice.
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio', undefined, -350);
  await openGenerate(nodeId);
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-gemini-3.1-flash-text-to-speech').click();

  const pill = page.getByTestId('generate-audio-settings-trigger');
  await expect(pill).toBeVisible({ timeout: 15_000 });
  expect(await pill.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('100px');
  await pill.click();

  const reading = page.getByTestId('generate-audio-reading-single');
  const language = page.getByTestId('generate-audio-row-language');
  const voice = page.getByTestId('generate-audio-row-voice_id');
  await expect(language).toBeVisible();
  const [r, l, v, p] = await Promise.all([reading, language, voice, pill].map((el) => el.boundingBox()));
  expect(r!.y).toBeLessThan(l!.y);
  expect(l!.y).toBeLessThan(v!.y);
  // The first panel opens over the pill.
  expect(v!.y + v!.height).toBeLessThanOrEqual(p!.y);

  // Language: a searchable list beside the first panel, one row per language.
  await language.click();
  const second = page.getByTestId('generate-audio-second-panel');
  await expect(second).toBeVisible();
  // Beside the first panel, on whichever side the window has room for it.
  const [lb, sb] = await Promise.all([language.boundingBox(), second.boundingBox()]);
  const width = page.viewportSize()!.width;
  expect(sb!.x >= lb!.x + lb!.width || sb!.x + sb!.width <= lb!.x).toBe(true);
  expect(sb!.x).toBeGreaterThanOrEqual(0);
  expect(sb!.x + sb!.width).toBeLessThanOrEqual(width);
  const options = page.locator('[data-testid^="generate-audio-option-language-"]:not([data-testid$="-search"])');
  await expect(options).toHaveCount(24);
  // Chosen by fill alone, no tick (design §16.1).
  const chosen = page.locator('[data-testid^="generate-audio-option-language-"][aria-pressed="true"]');
  await expect(chosen).toHaveCount(1);
  await expect(chosen.locator('svg')).toHaveCount(0);
  await options.nth(10).click();
  await expect(second).toBeHidden();

  // Dialogue: the voice row gives way to two fixed speakers.
  await page.getByTestId('generate-audio-reading-dialogue').click();
  await expect(page.getByTestId('generate-audio-row-voice_id')).toHaveCount(0);
  await page.getByTestId('generate-audio-row-speakers').click();
  await expect(page.getByTestId('generate-param-speakers-1-speaker')).toBeVisible();
  await expect(page.getByTestId('generate-param-speakers-2-speaker')).toHaveCount(0);
  await expect(page.getByTestId('generate-param-speakers-add')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('gemini-speakers.png') });

  // Two speakers left unnamed are refused on submit, naming the speakers.
  await page.keyboard.press('Escape');
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('Ada: Hello. Bo: Hi.');
  await page.getByTestId('generate-audio-execute').click();
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('Fill in the speakers', {
    timeout: 10_000,
  });
});

test('every voice of the default model plays its sample from the list', async ({ page }) => {
  // Design §16.4: the vendors behind Inworld, Gemini and MiniMax publish no
  // samples, so each voice has one of ours in this deployment's bucket.
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio', undefined, -350);
  await openGenerate(nodeId);
  await page.getByTestId('generate-audio-settings-trigger').click();
  await page.getByTestId('generate-audio-row-voice_id').click();

  const rows = page.locator('[data-testid^="generate-voice-option-"]');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const samples = page.locator('[data-testid^="generate-voice-sample-"]');
  expect(await samples.count()).toBe(await rows.count());

  const answered = page.waitForResponse((r) => r.url().includes('/voice-samples/'));
  await samples.first().click();
  // An audio element asks for a byte range, so the bucket answers 206.
  expect([200, 206]).toContain((await answered).status());
  await expect(samples.first()).toHaveAttribute('data-playing', 'true');
  // The play button sits at the right end of its row (design §16.1).
  const [row, button] = await Promise.all([
    rows.first().locator('..').boundingBox(),
    samples.first().boundingBox(),
  ]);
  expect(row!.x + row!.width - (button!.x + button!.width)).toBeLessThan(8);
  // Its playing ring, drawn 3px outside the button, stays clear of the 8px
  // scrollbar rail the list overlays on its right edge.
  const viewport = await page
    .getByTestId('generate-voice-list-body')
    .locator('[data-radix-scroll-area-viewport]')
    .boundingBox();
  expect(button!.x + button!.width + 3).toBeLessThanOrEqual(viewport!.x + viewport!.width - 8);
});

test('a sample speaks the language of its voice, or the one picked for a Gemini voice', async ({ page }) => {
  // User 2026-09-29: a Mandarin voice's sample is in Mandarin; a Gemini voice
  // speaks whichever language the panel has picked, and so does its sample.
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio', undefined, -350);
  await openGenerate(nodeId);
  const pill = page.getByTestId('generate-audio-settings-trigger');

  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-minimax-speech-2.8-hd').click();
  await pill.click();
  await page.getByTestId('generate-audio-row-voice_id').click();
  await page.getByTestId('generate-voice-search').fill('Mandarin');
  const mandarin = page.locator('[data-testid^="generate-voice-sample-Chinese (Mandarin)_"]').first();
  await expect(mandarin).toBeVisible({ timeout: 20_000 });
  const heard = page.waitForRequest((r) => r.url().includes('/voice-samples/'));
  await mandarin.click();
  expect((await heard).url()).toContain('/minimax-speech-2.8-hd/zh/');
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(pill).toHaveAttribute('aria-expanded', 'false', { timeout: 500 });
  }).toPass({ timeout: 5_000 });

  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-gemini-3.1-flash-text-to-speech').click();
  await pill.click();
  await page.getByTestId('generate-audio-row-language').click();
  await page.getByTestId('generate-audio-option-language-Japanese (Japan)').click();
  await page.getByTestId('generate-audio-row-voice_id').click();
  const sample = page.locator('[data-testid^="generate-voice-sample-"]').first();
  await expect(sample).toBeVisible({ timeout: 20_000 });
  const heardJa = page.waitForRequest((r) => r.url().includes('/voice-samples/'));
  await sample.click();
  expect((await heardJa).url()).toContain('/gemini-3.1-flash-text-to-speech/ja/');
});
