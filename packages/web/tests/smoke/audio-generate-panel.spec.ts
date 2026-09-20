// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Trying to generate audio on a canvas node, end to end (#1960 PR1).
 *
 * What no jsdom test reaches: the voice list comes from an endpoint that asks
 * a vendor, the panel opens off a real context menu on a real canvas node, and
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

import { openGenerate, seedNode } from '../helpers/audio-panel';

// One node, one panel, one continuous session — which is also how a person
// uses it: open it, look at it, adjust it, submit. Splitting these into a test
// each would reopen the panel three times and say nothing more.
test('the panel opens, offers what the model declares, and refuses a voiceless submit', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio');
  await openGenerate(nodeId);

  await expect(page.getByTestId('generate-audio-mode-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-model-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-voice-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-audio-tool-reference')).toBeVisible();
  // The rate, not a total: both vendors bill by how much text is sent.
  await expect(page.getByTestId('generate-audio-rate')).toBeVisible();

  // Both params are 0-1 ranges, so both render as sliders. Stability carries
  // the three positions ElevenLabs names on that scale beneath its own.
  await page.getByTestId('generate-audio-params-trigger').click();
  await expect(page.getByRole('slider', { name: /stability/i })).toBeVisible();
  await expect(page.getByRole('slider', { name: /similarity/i })).toBeVisible();
  await expect(page.getByTestId('generate-audio-stability-stop-0')).toBeVisible();
  await expect(page.getByTestId('generate-audio-stability-stop-0.5')).toBeVisible();
  await expect(page.getByTestId('generate-audio-stability-stop-1')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('Good evening.');
  await page.getByTestId('generate-audio-execute').click();

  // The refusal speaks: a yaml default is not a choice, so an untouched picker
  // means no voice rather than whichever one the catalog happens to list first.
  await expect(page.locator('[data-sonner-toast]').first()).toBeVisible({
    timeout: 10_000,
  });
});

test('text past the model’s limit is refused before anything is sent', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio');
  await openGenerate(nodeId);

  // elevenlabs-v3 takes 5,000 characters (elevenlabs.io/docs/models). Inserted
  // in one go rather than keystroke by keystroke: 5,001 of those would take
  // minutes, and what is under test is the length, not the typing.
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.insertText('x'.repeat(5001));

  await page.getByTestId('generate-audio-execute').click();

  // Named, not merely refused: the reader has to know how much to cut.
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('5,000', { timeout: 10_000 });
});

test('the voice list matches the deployment it is served from, and a pick survives a reopen @needs-tts', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'audio');
  await openGenerate(nodeId);

  await page.getByTestId('generate-voice-trigger').click();
  const options = page.locator('[data-testid^="generate-voice-option-"]');
  await expect(options.first()).toBeVisible({ timeout: 20_000 });

  // Two deployments, two sources (§6.1.1): a direct ElevenLabs or fish key
  // gets the vendor's live list, every row of which previews; WaveSpeed has no
  // voice endpoint, so the list is the catalog's own and nothing previews.
  // Asserting a count would pin this to whichever box ran it, so the invariant
  // is that the list is served WHOLE from one of the two — every row previews
  // or none does.
  const rows = await options.count();
  const samples = await page.locator('[data-testid^="generate-voice-sample-"]').count();
  expect(rows).toBeGreaterThan(0);
  expect([0, rows]).toContain(samples);

  const chosen = (await options.first().innerText()).split('\n')[0];
  const saysChosen = new RegExp(chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  await options.first().click();
  await expect(page.getByTestId('generate-voice-trigger')).toHaveText(saysChosen);

  // The pick is a parameter ON THE NODE, not panel state. Going to a second
  // audio node and back reads it off the document twice over: the panel that
  // opens on the untouched node must NOT show the first one's voice, and the
  // one that reopens on the first must still show it.
  const otherId = crypto.randomUUID();
  await seedNode(otherId, 'audio');
  await openGenerate(otherId);
  await expect(page.getByTestId('generate-voice-trigger')).not.toHaveText(saysChosen);

  await openGenerate(nodeId);
  await expect(page.getByTestId('generate-voice-trigger')).toHaveText(saysChosen);
});

test('an audio node with a produced asset can be picked into the talking-head driving slot', async ({ page }) => {
  // The slot's candidate rule is the node's TYPE and whether it holds an asset
  // (`CanvasSpace.tsx:3702`), not how the asset got there — so a seeded one
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
  // (`CanvasSpace.tsx:3702`), so a seeded audio node exercises the same path a
  // generated one takes without a vendor round trip. Seeded left of the origin
  // for the same reason the talking-head case is: the minimap in the
  // bottom-right corner sits above the panel and takes clicks meant for it.
  const sourceId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  await seedNode(sourceId, 'audio', 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0U=', -350);
  await seedNode(nodeId, 'audio', undefined, -50);
  await openGenerate(nodeId);

  // Text to speech first: the picker is there and the slot is not.
  await expect(page.getByTestId('generate-voice-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toHaveCount(0);

  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-voice-clone').click();

  // They swap. qwen3 declares no voice param, so a picker would offer a choice
  // that reaches nothing; what it needs instead is a recording to clone.
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('generate-voice-trigger')).toHaveCount(0);
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
  await expect(page.getByTestId('generate-voice-trigger')).toBeVisible({
    timeout: 15_000,
  });
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

  // Three slots, not one. The rule that used to decide this asked the catalog
  // "does this mode need an audio source", which reads true here as well and
  // would have offered the voice sample instead.
  await expect(page.getByTestId('generate-audio-tool-music-song')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('generate-audio-tool-music-voice')).toBeVisible();
  await expect(page.getByTestId('generate-audio-tool-music-instrumental')).toBeVisible();
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toHaveCount(0);

  // $0.35 a call, the price this model actually bills — it was declared as 10.
  await expect(page.getByTestId('generate-audio-rate')).toHaveText('35', {
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
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('Pick a song, vocals or backing', {
    timeout: 10_000,
  });

  // The middle slot alone is enough: the vendor takes whichever are given, and
  // a gate demanding a particular one would grey the button out for a user who
  // filled another.
  await page.getByTestId('generate-audio-tool-music-voice').click();
  await page.locator(`.react-flow__node[data-id="${sourceId}"]`).click();
  await expect(page.getByTestId('generate-audio-music-voice-clear')).toBeVisible({ timeout: 10_000 });

  // Stopping here rather than clicking submit again: with the gate satisfied
  // the click sends a real task to the vendor and spends the 35 credits this
  // model bills. Which of the three satisfies it is pinned by the unit case
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
  await expect(page.getByTestId('generate-audio-tool-music-voice')).toHaveCount(0);

  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-a2m').click();
  await expect(page.getByTestId('generate-audio-music-voice-clear')).toBeVisible({ timeout: 15_000 });
});
