// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space (#1490): made from New Space and New Project, its empty state, bottom bar and two panels, the
 * Timeline's way into it, one web animation made, modified, exported, put on a Canvas and found again from the Canvas,
 * and annotations shared between members.
 */
import { expect, type Locator, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { executeInMotion, motionDetails, openSpaceById, shownSpaceId, waitMotionFinished } from '../helpers/motion';
import { archiveProjects, openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { withTimelinePeer } from '../helpers/timeline-media';

/** The shortest prompt whose picture visibly changes over time. */
const PROMPT = 'A red circle moves from left to right across a white background.';
/** The shortest length the dialog allows; nothing here depends on the result's length. */
const SECONDS = 1;

/**
 * Press a Motion bar button and wait for it to be enabled first; Annotations waits while its document connects.
 * @throws {Error} When the button never becomes enabled.
 */
async function press(page: Page, testId: string): Promise<void> {
  const button = visibleSpace(page).getByTestId(testId);
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
}

/**
 * Scroll a Space type row to Motion with its end arrow and choose it. The row opens at its first card, and Motion, the
 * last, lies past its right edge until the row is scrolled.
 * @param dialog - The New Project or New Space dialog.
 * @param prefix - The row's test-id prefix.
 * @throws {Error} When the row never reaches Motion or Motion is not chosen.
 */
async function chooseMotion(dialog: Locator, prefix: string): Promise<void> {
  const viewport = dialog.getByTestId(`${prefix}-viewport`);
  const motion = dialog.getByTestId(`${prefix}-web_animation`);
  const end = dialog.getByTestId(`${prefix}-scroll-end`);
  /**
   * How far Motion's right edge lies past the row's.
   * @returns Pixels past the edge; zero or less when it is inside.
   */
  const motionOverflow = async (): Promise<number> => {
    const [card, row] = await Promise.all([motion.boundingBox(), viewport.boundingBox()]);
    if (card === null || row === null) throw new Error('The type row has no geometry');
    return card.x + card.width - (row.x + row.width);
  };
  await expect(dialog.getByTestId(`${prefix}-scroll-start`)).toHaveCount(0);
  await expect(end).toBeVisible();
  expect(await motionOverflow()).toBeGreaterThan(0);
  for (let presses = 0; presses < 5 && await end.count() > 0; presses += 1) {
    const before = await viewport.evaluate((element) => element.scrollLeft);
    await end.click();
    // The row scrolls smoothly; the next press waits for it to come to rest, since the arrow goes once the end is reached.
    let last = -1;
    await expect.poll(async () => {
      const now = await viewport.evaluate((element) => element.scrollLeft);
      const settled = now > before && now === last;
      last = now;
      return settled;
    }).toBe(true);
  }
  await expect(end).toHaveCount(0);
  await expect(dialog.getByTestId(`${prefix}-scroll-start`)).toBeVisible();
  await expect.poll(motionOverflow).toBeLessThanOrEqual(0);
  await motion.click();
  await expect(motion).toHaveAttribute('aria-checked', 'true');
}

test.use({ viewport: { width: 1680, height: 1100 } });

test('a Motion Space is made from New Space, opens empty, keeps one panel open at a time, and the Timeline\'s Make in Motion opens or makes one', async ({ page }) => {
  // The second Project of slot A: no case makes web animations there, so its picker is empty and it has no Motion Space.
  await openSmokeProject(page, 'A', 1);
  const made: string[] = [];
  try {
    const timelineId = await createSpace(page, 'timeline', `Motion entry timeline ${crypto.randomUUID()}`);
    made.push(timelineId);
    const timeline = visibleSpace(page);

    await test.step('Timeline: Add web animation lists nothing, and Make in Motion makes a Motion Space named Motion and opens it', async () => {
      await timeline.getByTestId('timeline-add-web-animation').click();
      const picker = page.getByTestId('timeline-web-animation-picker');
      await expect(picker).toBeVisible();
      await expect(picker.getByText('This Project has no web animations yet', { exact: true })).toBeVisible();
      await expect(picker.locator('[data-testid^="timeline-picker-row-"]')).toHaveCount(0);
      await picker.getByTestId('timeline-web-animation-go-make').click();
      await expect(picker).toHaveCount(0, { timeout: 30_000 });
      await expect(visibleSpace(page).getByTestId('motion-space')).toBeVisible();
      const motionId = await shownSpaceId(page);
      made.push(motionId);
      expect(motionId).not.toBe(timelineId);
      await expect(page.getByTestId(`space-tab-name-${motionId}`)).toHaveText('Motion');
    });

    await test.step('empty: the preview says there is nothing yet and offers New; play is unavailable', async () => {
      const motion = visibleSpace(page);
      await expect(motion.getByTestId('motion-empty')).toContainText('No web animations yet');
      await expect(motion.getByTestId('motion-empty-new')).toBeVisible();
      await expect(motion.getByTestId('motion-play')).toBeDisabled();
      await expect(motion.getByTestId('motion-preview')).toHaveCount(0);
      await expect(motion.getByTestId('motion-new')).toBeVisible();
    });

    await test.step('panels: Executions and Annotations open one at a time and close on a second press and on Esc', async () => {
      const motion = visibleSpace(page);
      const executions = motion.getByTestId('motion-panel-executions');
      const annotations = motion.getByTestId('motion-panel-annotations');
      await press(page, 'motion-open-executions');
      await expect(executions).toBeVisible();
      await expect(motion.getByTestId('motion-open-executions')).toHaveAttribute('aria-pressed', 'true');
      await expect(executions.getByRole('tab', { name: /^Completed/ })).toHaveAttribute('aria-selected', 'true');
      await expect(executions).toContainText('No web animations yet');
      // Annotations replaces Executions.
      await press(page, 'motion-open-annotations');
      await expect(annotations).toBeVisible();
      await expect(annotations).toContainText('No annotations yet');
      await expect(executions).toHaveCount(0);
      await expect(motion.getByTestId('motion-open-executions')).toHaveAttribute('aria-pressed', 'false');
      // A second press closes it.
      await press(page, 'motion-open-annotations');
      await expect(annotations).toHaveCount(0);
      // Esc closes either.
      await press(page, 'motion-open-executions');
      await expect(executions).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(executions).toHaveCount(0);
      await press(page, 'motion-open-annotations');
      await expect(annotations).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(annotations).toHaveCount(0);
    });

    await test.step('bar: play first and Executions, Annotations, New last; an open panel ends at the bar\'s right edge; each icon button is named on hover', async () => {
      const motion = visibleSpace(page);
      const bar = motion.getByTestId('motion-bottom-bar');
      const order = await bar.locator('button[data-testid]').evaluateAll((buttons) => buttons
        .map((button) => ({ id: button.getAttribute('data-testid') ?? '', x: button.getBoundingClientRect().left }))
        .sort((a, b) => a.x - b.x)
        .map((button) => button.id));
      expect(order[0]).toBe('motion-play');
      expect(order.slice(-3)).toEqual(['motion-open-executions', 'motion-open-annotations', 'motion-new']);

      const barBox = await bar.boundingBox();
      if (barBox === null) throw new Error('The bar has no geometry');
      for (const [button, panelId] of [['motion-open-executions', 'motion-panel-executions'], ['motion-open-annotations', 'motion-panel-annotations']] as const) {
        await press(page, button);
        const panel = motion.getByTestId(panelId);
        await expect(panel).toBeVisible();
        await expect.poll(async () => {
          const box = await panel.boundingBox();
          return box === null ? Infinity : Math.abs(box.x + box.width - (barBox.x + barBox.width));
        }).toBeLessThanOrEqual(1);
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
      }

      for (const [button, label] of [['motion-play', 'Play'], ['motion-open-executions', 'Executions'], ['motion-open-annotations', 'Annotations'], ['motion-new', 'New']] as const) {
        // A pointer path in steps, as a hand moves: one jump leaves the last tooltip waiting for a move that never comes.
        const box = await bar.getByTestId(button).boundingBox();
        if (box === null) throw new Error(`${button} has no geometry`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
        await expect(page.getByRole('tooltip')).toHaveText([label]);
      }
      await page.mouse.move(0, 0, { steps: 10 });
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    });

    await test.step('New Space: the type row scrolls to Motion, its last type, and the Timeline\'s Make in Motion opens the newest Motion Space', async () => {
      const name = `Motion newest ${crypto.randomUUID()}`;
      await page.getByTestId('new-space-button').click();
      const dialog = page.getByTestId('new-space-dialog');
      await chooseMotion(dialog, 'new-space-type');
      await dialog.getByTestId('new-space-name').fill(name);
      await dialog.getByTestId('new-space-submit').click();
      await expect(dialog).toHaveCount(0);
      await expect(visibleSpace(page).getByTestId('motion-space')).toBeVisible();
      const newestId = await shownSpaceId(page);
      made.push(newestId);
      await expect(page.getByTestId(`space-tab-name-${newestId}`)).toHaveText(name);
      await openSpaceById(page, timelineId);
      await timeline.getByTestId('timeline-add-web-animation').click();
      const picker = page.getByTestId('timeline-web-animation-picker');
      await picker.getByTestId('timeline-web-animation-go-make').click();
      await expect(picker).toHaveCount(0);
      expect(await shownSpaceId(page)).toBe(newestId);
      await expect(visibleSpace(page).getByTestId('motion-space')).toBeVisible();
    });
  } finally {
    // A picker left open in the Timeline is hidden with its tab and keeps the drawer from opening; bring it to the front
    // so the removals below can close it.
    if (made.length > 0) await openSpaceById(page, made[0]).catch(() => undefined);
    for (const id of made.reverse()) await deleteSpace(page, id);
  }
});

test('New Project scrolls its type row to Motion and opens the new Project on an empty Motion Space', async ({ page }) => {
  const { studioId } = await dataOf<{ studioId: string }>(await page.request.get(`/api/v1/projects/${smokeProjectId()}`), 'read the slot Project scope');
  const studios = await dataOf<Array<{ id: string; slug: string }>>(await page.request.get('/api/v1/studios'), 'list the slot account Studios');
  const studio = studios.find((candidate) => candidate.id === studioId);
  if (studio === undefined) throw new Error('the slot Project Studio is missing');
  let projectId: string | null = null;
  try {
    await page.goto(`/studio/${studio.slug}/projects`);
    await page.getByTestId('container-toolbar').getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByTestId('new-project-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('#new-project-name').fill(`Smoke run motion project ${Date.now()}`);
    await chooseMotion(dialog, 'new-project-type');
    const [response] = await Promise.all([
      page.waitForResponse((answer) => answer.request().method() === 'POST' && new URL(answer.url()).pathname === '/api/v1/projects'),
      dialog.getByRole('button', { name: 'Create', exact: true }).click(),
    ]);
    projectId = (await dataOf<{ id: string }>(response, 'create a Motion Project')).id;
    await expect(page).toHaveURL(new RegExp(`/project/[^/]*-${projectId}$`));
    await expect(page.locator('[data-testid^="space-tab-name-"]')).toHaveCount(1);
    const motion = visibleSpace(page).getByTestId('motion-space');
    await expect(motion).toBeVisible();
    await expect(motion.getByTestId('motion-empty')).toContainText('No web animations yet');
  } finally {
    // A Project's only Space cannot be deleted on its own; archiving removes the whole Project.
    if (projectId !== null) expect(await archiveProjects(page.request, [projectId]), 'Project cleanup').toEqual([]);
  }
});

test('one web animation is made, modified, exported, put on a Canvas that View opens, and Open source animation brings back its result or says its Space is gone @needs-model @needs-ingest @needs-storage', async ({ page }) => {
  // Two model runs and one render, each waited up to four minutes.
  test.setTimeout(900_000);
  await openSmokeProject(page);
  const canvasName = `Motion canvas ${crypto.randomUUID()}`;
  const canvasId = await createSpace(page, 'canvas', canvasName);
  const motionId = await createSpace(page, 'web_animation', `Motion make ${crypto.randomUUID()}`);
  let motionDeleted = false;
  try {
    const motion = visibleSpace(page);
    let created = '';
    await test.step('make: the shortest web animation runs and finishes playable', async () => {
      created = await executeInMotion(page, { prompt: PROMPT, seconds: SECONDS });
      await waitMotionFinished(page, created);
      await expect(motion.locator('[data-testid="motion-preview"] hyperframes-player')).toHaveCount(1);
      await expect(motion.getByTestId('motion-action-modify')).toBeVisible();
      await expect(motion.getByTestId('motion-action-export')).toBeVisible();
    });

    let modified = '';
    await test.step('modify: the dialog starts from the result, and the new result is a separate execution', async () => {
      await motion.getByTestId('motion-action-modify').click();
      const dialog = page.getByRole('dialog', { name: 'Modify web animation', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(PROMPT);
      await expect(dialog.getByTestId('web-animation-duration')).toHaveValue(String(SECONDS));
      await dialog.getByTestId('web-animation-prompt').fill('Make the circle blue.');
      await dialog.getByTestId('web-animation-execute').click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => motion.getByTestId('motion-preview').getAttribute('data-execution-id')).not.toBe(created);
      modified = (await motion.getByTestId('motion-preview').getAttribute('data-execution-id')) ?? '';
      await expect(motion.getByTestId(`motion-row-${modified}`)).toContainText(`Modified from “${PROMPT}”: Make the circle blue.`);
      await waitMotionFinished(page, modified);
    });

    let exported = '';
    await test.step('export: the result renders to a video, and the source then offers View video', async () => {
      await motion.getByTestId('motion-action-export').click();
      await expect.poll(() => motion.getByTestId('motion-preview').getAttribute('data-execution-id')).not.toBe(modified);
      exported = (await motion.getByTestId('motion-preview').getAttribute('data-execution-id')) ?? '';
      await expect(motion.getByTestId(`motion-row-${exported}`)).toContainText('Video · ');
      await waitMotionFinished(page, exported, 'video');
      await expect(motion.getByTestId('motion-action-download')).toBeEnabled();
      await expect(motion.getByTestId('motion-action-view-source')).toBeVisible();
    });

    await test.step('place: the video goes on the chosen Canvas, and the message\'s View opens that Canvas with the video selected', async () => {
      await expect(motion.getByTestId('motion-action-place-on-canvas')).toBeEnabled({ timeout: 30_000 });
      await motion.getByTestId('motion-action-place-on-canvas').click();
      await page.getByTestId(`motion-canvas-${canvasId}`).click();
      const placed = page.locator('[data-sonner-toast]').filter({ hasText: `Put on ${canvasName}` });
      await expect(placed).toBeVisible({ timeout: 60_000 });
      await placed.getByRole('button', { name: 'View', exact: true }).click();
      await expect(page.getByTestId(`space-tab-${canvasId}`)).toHaveAttribute('aria-selected', 'true');
      await expect(visibleSpace(page).locator('.react-flow__node.selected')).toHaveCount(1, { timeout: 30_000 });
      // Another result is in front before the Canvas asks for this one. Accepting the export opened the list.
      await openSpaceById(page, motionId);
      const list = motion.getByTestId('motion-panel-executions');
      if (await list.count() === 0) await motion.getByTestId('motion-open-executions').click();
      await list.getByRole('tab', { name: /^Completed/ }).click();
      await list.getByTestId(`motion-row-${created}`).click();
      await expect(motion.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', created);
      await page.keyboard.press('Escape');
    });

    await test.step('source: Open source animation on the Canvas video brings the Motion Space back on the modified result', async () => {
      await openSpaceById(page, canvasId);
      const node = visibleSpace(page).locator('.react-flow__node');
      await expect(node).toHaveCount(1, { timeout: 30_000 });
      await node.click({ button: 'right' });
      await page.getByTestId('node-menu-open-source-animation').click();
      await expect(page.locator(`[data-space-outlet="${motionId}"]`)).toBeVisible();
      await expect(visibleSpace(page).getByTestId('motion-preview')).toHaveAttribute('data-execution-id', modified);
    });

    await test.step('source gone: once the Motion Space is deleted, Open source animation says its Space is gone', async () => {
      await deleteSpace(page, motionId);
      await expect(page.getByTestId(`space-tab-name-${motionId}`)).toHaveCount(0);
      motionDeleted = true;
      await openSpaceById(page, canvasId);
      const node = visibleSpace(page).locator('.react-flow__node');
      await node.click({ button: 'right' });
      await page.getByTestId('node-menu-open-source-animation').click();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'The Space with the source animation is gone.' })).toBeVisible();
      await expect(page.getByTestId(`space-tab-${canvasId}`)).toHaveAttribute('aria-selected', 'true');
    });
  } finally {
    if (!motionDeleted) await deleteSpace(page, motionId);
    await deleteSpace(page, canvasId);
  }
});

test('an annotation with a point is seen, answered and resolved by another Editor, and a Viewer reads it without write controls @needs-model @needs-ingest', async ({ page, browser }) => {
  // One model run (up to four minutes) and two members joining in turn.
  test.setTimeout(600_000);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const motionId = await createSpace(page, 'web_animation', `Motion annotate ${crypto.randomUUID()}`);
  try {
    const motion = visibleSpace(page);
    const executionId = await executeInMotion(page, { prompt: PROMPT, seconds: SECONDS });
    await waitMotionFinished(page, executionId);
    await page.keyboard.press('Escape');

    const note = 'Make the circle bigger here.';
    let threadId = '';
    await test.step('add: Add annotation pauses, a click marks a point on the frame, and the sent thread has a marker and a pin', async () => {
      await press(page, 'motion-action-add-annotation');
      const draft = motion.getByTestId('motion-annotation-draft');
      await expect(draft).toBeVisible();
      const frame = motion.getByTestId('motion-preview');
      const box = await frame.boundingBox();
      if (box === null) throw new Error('The preview has no geometry');
      await frame.click({ position: { x: box.width * 0.25, y: box.height * 0.3 } });
      await draft.getByTestId('doc-comment-motion-annotation-input').fill(note);
      await draft.getByTestId('doc-comment-motion-annotation-save').click();
      await expect(draft).toHaveCount(0);
      const marker = motion.locator('[data-testid^="motion-marker-"]');
      await expect(marker).toHaveCount(1);
      threadId = ((await marker.getAttribute('data-testid')) ?? '').replace('motion-marker-', '');
      await expect(motion.getByTestId('motion-thread-card')).toContainText(note);
      // The pin's tip, its bottom-left corner, stands where the frame was clicked.
      const pin = await motion.getByTestId(`motion-pin-${threadId}`).boundingBox();
      if (pin === null) throw new Error('The pin has no geometry');
      expect(Math.abs(pin.x - (box.x + box.width * 0.25))).toBeLessThanOrEqual(3);
      expect(Math.abs(pin.y + pin.height - (box.y + box.height * 0.3))).toBeLessThanOrEqual(3);
      // The open-annotation count sits on the Annotations button's corner, beside the button itself.
      await expect(motion.getByTestId('motion-open-annotations').locator('..')).toHaveText('1');
    });

    await test.step('Editor: the other member finds it in Annotations, opens it on its point, replies and resolves', async () => {
      await withTimelinePeer(page, browser, projectId, 'editor', async (peer) => {
        await peer.goto(projectUrl);
        await openSpaceById(peer, motionId);
        const view = visibleSpace(peer);
        await expect(view.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', executionId, { timeout: 30_000 });
        await press(peer, 'motion-open-annotations');
        const item = view.getByTestId(`motion-annotation-${threadId}`);
        await expect(item).toContainText(note);
        await expect(item).toContainText('Marked on frame');
        await item.click();
        const card = view.getByTestId('motion-thread-card');
        await expect(card).toContainText(note);
        await expect(view.getByTestId(`motion-pin-${threadId}`)).toBeVisible();
        await card.getByTestId('doc-comment-reply-input').fill('Done, bigger now.');
        await card.getByTestId('doc-comment-reply-save').click();
        await expect(card.getByTestId('doc-comment-entry')).toHaveCount(2);
        await card.getByTestId('doc-comment-resolve').click();
        await expect(card.getByTestId('doc-comment-reopen')).toBeVisible();
        // Open leaves the resolved thread out.
        await expect(view.getByTestId(`motion-annotation-${threadId}`)).toHaveCount(0);
        await expect(view.getByTestId('motion-panel-annotations')).toContainText('No open annotations');
      });
      // The author sees the reply and the resolve.
      const card = motion.getByTestId('motion-thread-card');
      await expect(card.getByTestId('doc-comment-entry')).toHaveCount(2);
      await expect(card.getByTestId('doc-comment-reopen')).toBeVisible();
    });

    await test.step('Viewer: the result, its annotation and the thread are readable, with no control that writes', async () => {
      await withTimelinePeer(page, browser, projectId, 'viewer', async (peer) => {
        await peer.goto(projectUrl);
        await openSpaceById(peer, motionId);
        const view = visibleSpace(peer);
        await expect(view.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', executionId, { timeout: 30_000 });
        // The finished result anchors the absence checks below.
        await expect(view.getByTestId('motion-play')).toBeEnabled();
        await expect(view.getByTestId('motion-open-executions')).toBeVisible();
        for (const control of ['motion-new', 'motion-action-add-annotation', 'motion-action-modify', 'motion-action-export']) {
          await expect(view.getByTestId(control)).toHaveCount(0);
        }
        await press(peer, 'motion-open-annotations');
        const panel = view.getByTestId('motion-panel-annotations');
        await panel.getByTestId('motion-annotations-filter-all').click();
        await panel.getByTestId(`motion-annotation-${threadId}`).click();
        const card = view.getByTestId('motion-thread-card');
        await expect(card.getByTestId('doc-comment-entry')).toHaveCount(2);
        await expect(card).toContainText(note);
        for (const control of ['doc-comment-reply-input', 'doc-comment-resolve', 'doc-comment-reopen', 'doc-comment-delete']) {
          await expect(card.getByTestId(control)).toHaveCount(0);
        }
        await view.getByTestId('motion-details').click();
        await expect(motionDetails(peer)).toContainText('Succeeded');
        await expect(motionDetails(peer).getByTestId('motion-cancel')).toHaveCount(0);
      });
    });
  } finally {
    await deleteSpace(page, motionId);
  }
});
