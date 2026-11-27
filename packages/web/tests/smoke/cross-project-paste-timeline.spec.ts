// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A video copied on one Project's canvas and pasted onto another Project's canvas joins the second Project's media
 * (inner#2171): its Timeline lists it among the Project's videos, and the video's cover never shows up as a picture of
 * its own.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ProjectAssetPage } from '@breatic/shared';
import { expect, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { addProjectTimelineVideo, expectTimelineVideoReady, openTimeline } from '../helpers/timeline-media';
import { dropFile, watchQueuedFinish } from '../helpers/upload';
import { roomForUploads } from '../helpers/upload-budget';

test.use({ viewport: { width: 1500, height: 900 } });

const CLIP = readFileSync(resolve(__dirname, '../fixtures/media-history.mp4'));

/**
 * The fixture clip with a `free` box of noise after its last box, so no earlier run's upload dedups it and neither
 * Project already holds it.
 * @returns The clip's bytes.
 */
function uniqueClip(): Buffer {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(box.length, 0);
  box.write('free', 4, 'ascii');
  randomBytes(16).copy(box, 8);
  return Buffer.concat([CLIP, box]);
}

/**
 * The video nodes of the displayed canvas, read from the module serving it.
 * @param page - A page with the canvas Space displayed.
 * @param projectId - The Project.
 * @param spaceId - The canvas Space.
 * @returns Each video node's id and stored address.
 */
async function videoNodes(page: Page, projectId: string, spaceId: string): Promise<{ id: string; content: string | null }[]> {
  const moduleUrl = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(async ({ projectId, spaceId, moduleUrl }) => {
    const canvas = await import(/* @vite-ignore */ moduleUrl) as {
      readCanvasGraph: (projectId: string, spaceId: string) => { nodes: { id: string; type: string; data: { content?: unknown } }[] };
    };
    return canvas.readCanvasGraph(projectId, spaceId).nodes
      .filter((node) => node.type === 'video')
      .map((node) => ({ id: node.id, content: typeof node.data.content === 'string' ? node.data.content : null }));
  }, { projectId, spaceId, moduleUrl });
}

/**
 * Every address a Project's media list holds of one kind, across all its pages.
 * @param page - A page signed in as a member of the Project.
 * @param projectId - The Project.
 * @param kind - Which kind of media.
 * @returns The listed addresses.
 */
async function listedUrls(page: Page, projectId: string, kind: 'video' | 'image'): Promise<string[]> {
  const urls: string[] = [];
  let cursor: string | null = null;
  do {
    const params: Record<string, string> = cursor === null ? { kind } : { kind, cursor };
    const listed: ProjectAssetPage = await dataOf<ProjectAssetPage>(
      await page.request.get(`/api/v1/projects/${projectId}/assets`, { params }), `read the Project ${kind} list`,
    );
    urls.push(...listed.items.map((item) => item.fileUrl));
    cursor = listed.nextCursor;
  } while (cursor !== null);
  return urls;
}

test('a video pasted from another Project\'s canvas is listed in this Project\'s Timeline, without its cover as a picture @needs-storage @needs-ingest', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const source = { projectId: smokeProjectId('A', 0), spaceId: null as string | null };
  const target = { projectId: smokeProjectId('A', 1), canvasId: null as string | null, timelineId: null as string | null };
  let other: Page | null = null;
  try {
    // Project A: a video dropped on its canvas, uploaded the way a user drops one.
    await openSmokeProject(page, 'A', 0);
    source.spaceId = await createSpace(page, 'canvas', `paste-source-${crypto.randomUUID()}`);
    await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    await roomForUploads(1);
    const finished = watchQueuedFinish(page);
    await dropFile(page, `paste-source-${crypto.randomUUID()}.mp4`, 'video/mp4', uniqueClip());
    const { delivered } = await finished;
    expect(delivered.coverUrl, 'the stored video has a cover of its own').not.toBeNull();
    const coverUrl = delivered.coverUrl!;
    const sourceId = source.spaceId;
    await expect.poll(async () => (await videoNodes(page, source.projectId, sourceId)).map((node) => node.content), { timeout: 120_000 })
      .toEqual([delivered.fileUrl]);
    const [sourceNode] = await videoNodes(page, source.projectId, sourceId);

    // Copy the node: click its top edge, where no control sits, then the copy shortcut.
    const drawn = visibleSpace(page).locator(`.react-flow__node[data-id="${sourceNode.id}"]`);
    const box = await drawn.boundingBox();
    if (box === null) throw new Error('the video node is not on screen');
    await page.mouse.click(box.x + box.width / 2, box.y + 6);
    await expect(drawn).toHaveClass(/selected/);
    await page.keyboard.press('ControlOrMeta+C');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(delivered.fileUrl);

    // Project B, in the same Studio, does not hold the video before the paste.
    other = await context.newPage();
    await openSmokeProject(other, 'A', 1);
    expect(await listedUrls(other, target.projectId, 'video')).not.toContain(delivered.fileUrl);
    target.canvasId = await createSpace(other, 'canvas', `paste-target-${crypto.randomUUID()}`);
    await expect(visibleSpace(other).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    await other.bringToFront();
    const pane = await visibleSpace(other).locator('.react-flow__pane').boundingBox();
    if (pane === null) throw new Error('the target canvas is not on screen');
    await other.mouse.click(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await other.keyboard.press('ControlOrMeta+V');
    const targetCanvas = target.canvasId;
    // Same Studio: the copy points at the address the original already holds.
    await expect.poll(async () => (await videoNodes(other!, target.projectId, targetCanvas)).map((node) => node.content), { timeout: 30_000 })
      .toEqual([delivered.fileUrl]);

    // Project B's Timeline lists the pasted video among the Project's videos and places it.
    target.timelineId = await createSpace(other, 'timeline', `paste-timeline-${crypto.randomUUID()}`);
    await openTimeline(other, target.timelineId);
    await expect(visibleSpace(other).getByTestId('timeline-space-empty')).toBeVisible();
    const clipId = await addProjectTimelineVideo(other, delivered.assetId);
    await expectTimelineVideoReady(other, clipId, delivered.fileUrl);

    // The cover belongs to the video: neither Project lists it as a picture of its own.
    expect(await listedUrls(other, target.projectId, 'image')).not.toContain(coverUrl);
    expect(await listedUrls(page, source.projectId, 'image')).not.toContain(coverUrl);
  } finally {
    if (other !== null) {
      if (target.timelineId !== null) await deleteSpace(other, target.timelineId);
      if (target.canvasId !== null) await deleteSpace(other, target.canvasId);
      await other.close();
    }
    if (source.spaceId !== null) await deleteSpace(page, source.spaceId);
  }
});
