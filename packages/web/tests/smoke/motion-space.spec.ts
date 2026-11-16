// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space (#1490): made from New Space, its empty state and its two panels, the Timeline's way into it, one
 * web animation made, modified, exported, put on a Canvas and found again from the Canvas, and annotations shared
 * between members.
 */
import { expect, type Page } from 'playwright/test';

import { executeInMotion, motionDetails, openSpaceById, shownSpaceId, waitMotionFinished } from '../helpers/motion';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
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

    await test.step('New Space: Motion is the last type of the row, and the Timeline\'s Make in Motion opens the newest Motion Space', async () => {
      const newestId = await createSpace(page, 'web_animation', `Motion newest ${crypto.randomUUID()}`);
      made.push(newestId);
      await expect(visibleSpace(page).getByTestId('motion-space')).toBeVisible();
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

test('one web animation is made, modified, exported, put on a Canvas, and Open source animation brings back its result @needs-model @needs-ingest @needs-storage', async ({ page }) => {
  // Two model runs and one render, each waited up to four minutes.
  test.setTimeout(900_000);
  await openSmokeProject(page);
  const canvasName = `Motion canvas ${crypto.randomUUID()}`;
  const canvasId = await createSpace(page, 'canvas', canvasName);
  const motionId = await createSpace(page, 'web_animation', `Motion make ${crypto.randomUUID()}`);
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

    await test.step('place: the video goes on the chosen Canvas', async () => {
      await expect(motion.getByTestId('motion-action-place-on-canvas')).toBeEnabled({ timeout: 30_000 });
      await motion.getByTestId('motion-action-place-on-canvas').click();
      await page.getByTestId(`motion-canvas-${canvasId}`).click();
      await expect(page.getByText(`Put on ${canvasName}`, { exact: true })).toBeVisible({ timeout: 60_000 });
      // Another result is in front before the Canvas asks for this one. Accepting the export opened the list.
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
  } finally {
    await deleteSpace(page, motionId);
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
      // The pin stands where the frame was clicked.
      const pin = await motion.getByTestId(`motion-pin-${threadId}`).boundingBox();
      if (pin === null) throw new Error('The pin has no geometry');
      expect(Math.abs(pin.x + pin.width / 2 - (box.x + box.width * 0.25))).toBeLessThanOrEqual(3);
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
        await panel.getByRole('button', { name: 'All 1', exact: true }).click();
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
