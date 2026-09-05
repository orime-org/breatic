// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The audio Generate panel, end to end (#1960 PR1).
 *
 * What no jsdom test reaches: the voice list comes from an endpoint that asks
 * a vendor, the panel opens off a real context menu on a real canvas node, and
 * the submit gate is judged against a prompt the collaborative editor
 * serialized rather than a string a test handed it.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 *
 * Skips itself when the credentials are absent, so an unconfigured checkout
 * still passes the suite.
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.describe.configure({ mode: 'serial' });

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * Sign in and leave the page wherever the app lands.
 * @param p - A fresh page.
 */
async function signIn(p: Page): Promise<void> {
  await p.goto('/login');
  await p.locator('#login-email').fill(email as string);
  await p.locator('#login-password').fill(password as string);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

/**
 * Where the next seeded node goes, and what to clear afterwards.
 *
 * Two constraints meet here. A node is 288 wide, so dropping them all at one
 * point stacks them and a right-click meant for the one underneath lands on
 * whatever was seeded last. And the canvas mounts only what the viewport
 * intersects (`onlyRenderVisibleElements`, `CanvasSpace.tsx:3831`), so a row
 * that keeps growing across cases walks off the edge and the node is not in
 * the DOM at all. Clearing between cases holds both: every case starts its own
 * row at the origin.
 */
const SEED_STEP = 300;
let seededSoFar = 0;
const seededIds: string[] = [];

/**
 * Write one node into the open Space's document.
 *
 * Seeded rather than generated: what this file is here to exercise is the
 * panel, and a node arrives on the canvas by upload or by an earlier
 * generation — neither of which these cases are about.
 *
 * The id is a UUID because the task endpoint's schema requires one for both
 * `target_node_id` and every key of `node_gens`; a readable id gets the submit
 * rejected at the boundary, which no case here is about.
 * @param p - A page with the Space open.
 * @param nodeId - The id to give the node, a UUID.
 * @param kind - The node type to write.
 * @param content - The asset URL the node holds, if any.
 * @param atX - Where to put it, overriding the running row.
 * @param atY - How far up to put it. The panel hangs BELOW its node
 *   (`generate-panel-frame.tsx:196`, `Position.Bottom`, no flip), so a taller
 *   panel runs further past the window bottom — the music modes carry a second
 *   editor and reach 396px against this suite's 720px window. Raising the node
 *   is what a person does by panning.
 */
async function seedNode(
  p: Page,
  nodeId: string,
  kind: 'audio' | 'video',
  content?: string,
  atX?: number,
  atY = 0,
): Promise<void> {
  await expect(p.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const x = atX ?? seededSoFar * SEED_STEP;
  seededSoFar += 1;
  seededIds.push(nodeId);
  const seen = await p.evaluate(
    async ([pid, sid, id, type, asset, left, top]: [
      string,
      string,
      string,
      string,
      string,
      number,
      number,
    ]) => {
      // Vite serves each module under a versioned URL; importing the bare path
      // would evaluate a SECOND copy whose caches are empty.
      const live = (re: RegExp): string => {
        const found = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => re.test(n));
        if (found === undefined) throw new Error(`no module matches ${re.source}`);
        return found;
      };
      const canvas = (await import(
        /* @vite-ignore */ live(/data\/yjs\/canvas-space\.ts/)
      )) as {
        addNode: (p: string, s: string, n: unknown) => void;
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string }[] };
      };
      canvas.addNode(pid, sid, {
        id,
        type,
        position: { x: left, y: top },
        data: {
          name: `${type}-e2e`,
          createdAt: Date.now(),
          createdBy: 'audio-e2e',
          locked: false,
          state: 'idle',
          attachments: [],
          ...(asset ? { content: asset, status: 'ready' } : {}),
        },
      });
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id);
    },
    [projectId, spaceId, nodeId, kind, content ?? '', x, atY] as [
      string,
      string,
      string,
      string,
      string,
      number,
      number,
    ],
  );
  if (!seen.includes(nodeId)) {
    throw new Error(`${nodeId} never reached the document; saw [${seen.join(', ')}]`);
  }
}

/**
 * Open the Generate panel on a node the way a person does: right-click, then
 * the menu item.
 * @param p - A page with the Space open.
 * @param nodeId - The node to open it on.
 * @param settled - A testid the open panel is known to render, waited on.
 */
async function openGenerate(
  p: Page,
  nodeId: string,
  settled = 'generate-audio-execute',
): Promise<void> {
  const node = p.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await p.getByTestId('node-menu-generate').click();
  await expect(p.getByTestId(settled)).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signIn(page);
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 20_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\/[^/]+/, { timeout: 15_000 });
  // The URL segment is the project's SLUG, which ends in its id. Splitting on
  // `/project/` yields the slug, and a Yjs document named after that is a
  // second, empty one — writes into it land nowhere the canvas reads.
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  spaceId = await createSpace(page, 'canvas', `audio-e2e-${Date.now()}`);
});

test.afterEach(async () => {
  if (seededIds.length === 0) return;
  const ids = seededIds.splice(0);
  seededSoFar = 0;
  await page.evaluate(
    async ([pid, sid, list]: [string, string, string[]]) => {
      const found = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => /data\/yjs\/canvas-space\.ts/.test(n));
      if (found === undefined) return;
      const canvas = (await import(/* @vite-ignore */ found)) as {
        removeNode: (p: string, s: string, n: string) => void;
      };
      for (const id of list) canvas.removeNode(pid, sid, id);
    },
    [projectId, spaceId, ids] as [string, string, string[]],
  );
});

test.afterAll(async () => {
  if (spaceId) await deleteSpace(page, spaceId);
  await page.close();
});

// One node, one panel, one continuous session — which is also how a person
// uses it: open it, look at it, adjust it, submit. Splitting these into a test
// each would reopen the panel three times and say nothing more.
test('the panel opens, offers what the model declares, and refuses a voiceless submit', async () => {
  test.setTimeout(90_000);
  const nodeId = crypto.randomUUID();
  await seedNode(page, nodeId, 'audio');
  await openGenerate(page, nodeId);

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

test('text past the model’s limit is refused before anything is sent', async () => {
  test.setTimeout(90_000);
  const nodeId = crypto.randomUUID();
  await seedNode(page, nodeId, 'audio');
  await openGenerate(page, nodeId);

  // elevenlabs-v3 takes 5,000 characters (elevenlabs.io/docs/models). Inserted
  // in one go rather than keystroke by keystroke: 5,001 of those would take
  // minutes, and what is under test is the length, not the typing.
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.insertText('x'.repeat(5001));

  await page.getByTestId('generate-audio-execute').click();

  // Named, not merely refused: the reader has to know how much to cut.
  await expect(page.locator('[data-sonner-toast]').first()).toContainText(
    '5,000',
    { timeout: 10_000 },
  );
});

test('the voice list matches the deployment it is served from, and a pick survives a reopen', async () => {
  test.setTimeout(90_000);
  const nodeId = crypto.randomUUID();
  await seedNode(page, nodeId, 'audio');
  await openGenerate(page, nodeId);

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
  const samples = await page
    .locator('[data-testid^="generate-voice-sample-"]')
    .count();
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
  await seedNode(page, otherId, 'audio');
  await openGenerate(page, otherId);
  await expect(page.getByTestId('generate-voice-trigger')).not.toHaveText(
    saysChosen,
  );

  await openGenerate(page, nodeId);
  await expect(page.getByTestId('generate-voice-trigger')).toHaveText(saysChosen);
});

test('an audio node with a produced asset can be picked into the talking-head driving slot', async () => {
  test.setTimeout(90_000);
  // The slot's candidate rule is the node's TYPE and whether it holds an asset
  // (`CanvasSpace.tsx:3702`), not how the asset got there — so a seeded one
  // exercises the same path a generated one takes, without a vendor round trip.
  // Seeded to the left of the origin: the video panel is wide, and opened on a
  // node any further right it reaches the minimap in the bottom-right corner,
  // which sits above it and takes the clicks meant for the slot row.
  const audioId = crypto.randomUUID();
  const videoId = crypto.randomUUID();
  await seedNode(
    page,
    audioId,
    'audio',
    'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0U=',
    -350,
  );
  await seedNode(page, videoId, 'video', undefined, -50);

  await openGenerate(page, videoId, 'generate-video-mode-trigger');
  await page.getByTestId('generate-video-mode-trigger').click();
  await page.getByTestId('generate-video-mode-talking-head').click();

  await page.getByTestId('generate-video-tool-driving-audio').click();
  await page.locator(`.react-flow__node[data-id="${audioId}"]`).click();

  // The clear button, not the thumbnail: a filled slot draws a thumbnail from
  // the pick's cover, and an audio node carries no poster — the toolbar covers
  // the button with the audio icon instead (the `storesCover` comment on
  // `video-slots.ts`'s drivingAudio entry says why). The clear button is what
  // says the slot is holding something whatever the kind is.
  await expect(
    page.getByTestId('generate-video-driving-audio-clear'),
  ).toBeVisible({ timeout: 10_000 });
});

// One node, one panel, one session again: switching to voice cloning, picking
// the recording to clone, and submitting are the steps of a single use, and the
// state each leaves is what the next one reads.
test('voice cloning swaps the voice picker for a slot, and refuses a submit with nothing picked', async () => {
  test.setTimeout(90_000);
  // The candidate rule is the node's TYPE and whether it holds an asset
  // (`CanvasSpace.tsx:3702`), so a seeded audio node exercises the same path a
  // generated one takes without a vendor round trip. Seeded left of the origin
  // for the same reason the talking-head case is: the minimap in the
  // bottom-right corner sits above the panel and takes clicks meant for it.
  const sourceId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  await seedNode(
    page,
    sourceId,
    'audio',
    'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0U=',
    -350,
  );
  await seedNode(page, nodeId, 'audio', undefined, -50);
  await openGenerate(page, nodeId);

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
  await expect(page.locator('[data-sonner-toast]').first()).toContainText(
    'Pick a voice sample first',
    { timeout: 10_000 },
  );

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

test('the stability tick labels are a pointer target the standard accepts', async () => {
  // WCAG 2.2 SC 2.5.8 (AA) takes 24x24 CSS px, or 24px-diameter circles on
  // each undersized target that do not intersect. The three ticks sit 6px
  // under a 12px slider thumb, so the spacing exception cannot rescue them —
  // measured at 20.32px between the two circles' centres before this case
  // existed. A pointer aimed at "Natural" that lands 4px high drags the value
  // instead.
  const nodeId = crypto.randomUUID();
  await seedNode(page, nodeId, 'audio');
  await openGenerate(page, nodeId);

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
    const height = await ticks
      .nth(i)
      .evaluate((el) => parseFloat(getComputedStyle(el).height));
    expect(height, `tick ${i} height`).toBeGreaterThanOrEqual(24);
  }
});

test('the voice list stands the five rows it is sized for', async () => {
  // The height constant counts five rows of content, and the box it is set on
  // carries its own padding — which `border-box` takes out of that same
  // number, leaving the fifth row 8px short of a row. Measured against the
  // rows themselves: the fifth one is either a whole row tall inside the
  // scroller, or it is not there.
  const nodeId = crypto.randomUUID();
  await seedNode(page, nodeId, 'audio');
  await openGenerate(page, nodeId);

  await page.getByTestId('generate-voice-trigger').click();
  const body = page.getByTestId('generate-voice-list-body');
  await expect(body).toBeVisible({ timeout: 20_000 });
  const options = page.locator('[data-testid^="generate-voice-option-"]');
  await expect(options.first()).toBeVisible({ timeout: 20_000 });
  if ((await options.count()) < 5) test.skip(true, 'deployment serves under five voices');

  const room = await body.evaluate((el) => {
    const cs = getComputedStyle(el);
    return (
      el.getBoundingClientRect().height -
      parseFloat(cs.paddingTop) -
      parseFloat(cs.paddingBlockEnd || cs.paddingBottom)
    );
  });
  const fifthBottom = await options.nth(4).evaluate((el) => el.getBoundingClientRect().bottom);
  const contentTop = await body.evaluate(
    (el) => el.getBoundingClientRect().top + parseFloat(getComputedStyle(el).paddingTop),
  );
  expect(fifthBottom - contentTop).toBeLessThanOrEqual(room + 0.5);
});

test('the voice playing is marked by a ring drawn outside its button', async () => {
  // Design §6.3 (user 2026-09-01): the sample button gets a turning ring on
  // its outside — an `inset:-3px` pseudo-element that leaves the 24x24 target
  // alone — and it holds still under `prefers-reduced-motion`. Swapping the
  // glyph is the whole of what the row said before this case existed.
  const nodeId = crypto.randomUUID();
  await seedNode(page, nodeId, 'audio');
  await openGenerate(page, nodeId);

  await page.getByTestId('generate-voice-trigger').click();
  const samples = page.locator('[data-testid^="generate-voice-sample-"]');
  await expect(page.locator('[data-testid^="generate-voice-option-"]').first()).toBeVisible({
    timeout: 20_000,
  });
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

test('sound effects: a length picker, and a credit figure that follows it', async () => {
  const nodeId = crypto.randomUUID();
  await seedNode(page, nodeId, 'audio', undefined, 250);
  await openGenerate(page, nodeId);

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
  await expect(
    page.getByTestId('generate-prompt-editor').locator('[data-placeholder]').first(),
  ).toHaveAttribute('data-placeholder', /sound/i);

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

test('text to music: two boxes, a switch, and an empty lyrics box refuses the submit', async () => {
  test.setTimeout(90_000);
  const nodeId = crypto.randomUUID();
  // Raised, because this panel carries two editors and stands 396px against
  // the suite's 720px window — measured 2026-09-05, against 234px on the
  // sound-effect mode. Left of the origin for the reason the other cases are:
  // the minimap in the bottom-right corner takes clicks meant for the panel.
  await seedNode(page, nodeId, 'audio', undefined, -50, -240);
  await openGenerate(page, nodeId);

  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-t2m').click();

  // The mode's own model, and its flat price. minimax/music-3.0 bills $0.15 a
  // call whatever the brief says, so the figure holds at 15 while text is
  // typed — the two speech models move with the prompt, and this one is the
  // first on this panel that does not.
  await expect(page.getByTestId('generate-audio-rate')).toHaveText('15', {
    timeout: 15_000,
  });

  // A style box and a lyrics box, each carrying a word saying which it is.
  const style = page.getByTestId('generate-prompt-editor');
  const lyrics = page.getByTestId('generate-lyrics-editor');
  await expect(style).toBeVisible();
  await expect(lyrics).toBeVisible();
  await expect(
    style.locator('[data-placeholder]').first(),
  ).toHaveAttribute('data-placeholder', /genre|mood|instrument/i);
  await expect(
    lyrics.locator('[data-placeholder]').first(),
  ).toHaveAttribute('data-placeholder', /lyric/i);

  // The style box opens at half the lyrics box's height (user 2026-09-05): a
  // brief is a line or two of words, and the words to sing are a whole song.
  // Both grow as they are typed into and cap at the same ceiling; what differs
  // is where each one starts.
  const heights = await page.evaluate(() => {
    const h = (id: string) =>
      Math.round(
        document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().height ?? 0,
      );
    return { style: h('generate-prompt-editor'), lyrics: h('generate-lyrics-editor') };
  });
  expect(heights.lyrics).toBeGreaterThan(0);
  expect(heights.style).toBeGreaterThan(0);
  // 60 against 106 measured 2026-09-05. A band rather than the two numbers:
  // both floors are stated in rem and the ratio is what was asked for, so a
  // type-scale change moves both and this still holds.
  expect(heights.style / heights.lyrics).toBeGreaterThan(0.4);
  expect(heights.style / heights.lyrics).toBeLessThan(0.62);

  // Nothing here picks a voice, clones one, or collects a reference: the mode
  // states its slots and this one states none.
  await expect(page.getByTestId('generate-voice-trigger')).toHaveCount(0);
  await expect(page.getByTestId('generate-audio-tool-ref-audio')).toHaveCount(0);
  await expect(page.getByTestId('generate-audio-tool-music-song')).toHaveCount(0);

  // A brief alone leaves the button live and the click says what is missing —
  // the gateway refuses this model without lyrics, so the panel says so first
  // rather than letting the user watch a generation start and fail.
  await style.click();
  await page.keyboard.type('warm indie folk, fingerpicked guitar, 90 BPM');
  await expect(page.getByTestId('generate-audio-execute')).toBeEnabled();
  await page.getByTestId('generate-audio-execute').click();
  await expect(page.locator('[data-sonner-toast]').first()).toContainText(
    'Write the lyrics first',
    { timeout: 10_000 },
  );

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
  // The lyrics box says so too: nothing to write while the track has no
  // vocals, and what is already in it stays.
  await expect(
    page.getByTestId('generate-lyrics-editor').locator('.ProseMirror'),
  ).toHaveAttribute('contenteditable', 'false');
  // Off again, so the case leaves the node the way it found it.
  await instrumental.click();
  await expect(instrumental).toHaveAttribute('aria-checked', 'false', {
    timeout: 10_000,
  });
  await expect(pill).toContainText('With vocals', { timeout: 10_000 });
  await page.keyboard.press('Escape');
});

test('reference to music: three slots, and any one of them satisfies the gate', async () => {
  test.setTimeout(120_000);
  // Seeded left of the origin: the minimap in the bottom-right corner sits
  // above the panel and takes clicks meant for it (#2051).
  const sourceId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  await seedNode(
    page,
    sourceId,
    'audio',
    'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0U=',
    -350,
    -240,
  );
  await seedNode(page, nodeId, 'audio', undefined, -50, -240);
  await openGenerate(page, nodeId);

  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-a2m').click();

  // Three slots, not one. The rule that used to decide this asked the catalog
  // "does this mode need an audio source", which reads true here as well and
  // would have offered the voice sample instead.
  await expect(page.getByTestId('generate-audio-tool-music-song')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('generate-audio-tool-music-voice')).toBeVisible();
  await expect(
    page.getByTestId('generate-audio-tool-music-instrumental'),
  ).toBeVisible();
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
  await expect(page.locator('[data-sonner-toast]').first()).toContainText(
    'Pick a song, vocals or backing',
    { timeout: 10_000 },
  );

  // The middle slot alone is enough: the vendor takes whichever are given, and
  // a gate demanding a particular one would grey the button out for a user who
  // filled another.
  await page.getByTestId('generate-audio-tool-music-voice').click();
  await page.locator(`.react-flow__node[data-id="${sourceId}"]`).click();
  await expect(
    page.getByTestId('generate-audio-music-voice-clear'),
  ).toBeVisible({ timeout: 10_000 });

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
  await expect(
    page.getByTestId('generate-audio-music-voice-clear'),
  ).toBeVisible({ timeout: 15_000 });
});
