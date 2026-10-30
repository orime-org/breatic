// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Understanding an uploaded long audio file through the real canvas path. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { registerCanvasStage } from '../helpers/audio-panel';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { visibleSpace } from '../helpers/space';
import { dropFile, watchQueuedFinish } from '../helpers/upload';
import { roomForUploads } from '../helpers/upload-budget';
import { createOversizedLongAudioFixture, createOversizedLongVideoFixture } from '../helpers/long-media-fixtures';

registerCanvasStage();
test.use({ viewport: { width: 1680, height: 1050 } });

interface CanvasNode {
  id: string;
  type: string;
  data: { content?: string; mimeType?: string };
  bodyText?: string;
}

interface CanvasState {
  nodes: CanvasNode[];
}

interface CompletedUnderstandTask {
  status: string;
  result: { outputs: { content: string }[]; finish_reason: string };
}

/**
 * Read the graph and text bodies from the modules serving the open Space.
 * @param page - The signed-in page.
 * @returns The displayed canvas state.
 * @throws {Error} When the page has no Project or Space.
 */
async function canvasState(page: Page): Promise<CanvasState> {
  const projectId = /([0-9a-f-]{36})$/.exec(page.url())?.[1];
  const spaceId = await visibleSpace(page).getAttribute('data-space-outlet');
  if (projectId === undefined || spaceId === null) throw new Error('no displayed Project or Space');
  const moduleUrl = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(async ({ projectId, spaceId, moduleUrl }) => {
    const canvas = await import(/* @vite-ignore */ moduleUrl) as {
      readCanvasGraph: (projectId: string, spaceId: string) => { nodes: CanvasNode[] };
      readTextBodies: (projectId: string, spaceId: string, nodeIds: string[]) => Map<string, string>;
    };
    const graph = canvas.readCanvasGraph(projectId, spaceId);
    const bodies = canvas.readTextBodies(projectId, spaceId, graph.nodes.map((node) => node.id));
    return { nodes: graph.nodes.map((node) => ({ ...node, bodyText: bodies.get(node.id) })) };
  }, { projectId, spaceId, moduleUrl });
}

/**
 * Wait for an Understand task to reach a terminal state and require success.
 * @param page - The signed-in page.
 * @param taskId - The task to read.
 * @returns The completed task and its result.
 * @throws {Error} When the task fails, expires, or cannot be read.
 */
async function completedUnderstandTask(page: Page, taskId: string): Promise<CompletedUnderstandTask> {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/tasks/${taskId}`);
    if (!response.ok()) return `http-${response.status()}`;
    const { data: task } = await response.json() as { data: { status: string } };
    return task.status;
  }, { timeout: 420_000, intervals: [2_000] }).toMatch(/^(completed|failed|expired)$/);

  const response = await page.request.get(`/api/v1/tasks/${taskId}`);
  if (!response.ok()) throw new Error(`The Understand task read answered ${response.status()}.`);
  const { data: task } = await response.json() as { data: CompletedUnderstandTask };
  expect(task.status).toBe('completed');
  return task;
}

test('understands a long uploaded audio file and writes its result @needs-model @needs-internet @needs-storage @needs-ingest @needs-ffmpeg', async ({ page }) => {
  test.setTimeout(600_000);
  const workDir = mkdtempSync(join(tmpdir(), 'breatic-long-audio-understand-'));
  try {
    const limitsResponse = await page.request.get('/api/v1/canvas/limits');
    expect(limitsResponse.status()).toBe(200);
    const { data: { understandMaxBytes, understandLongMediaMaxBytes } } = await limitsResponse.json() as {
      data: { understandMaxBytes: number; understandLongMediaMaxBytes: number };
    };
    expect(understandLongMediaMaxBytes).toBeGreaterThan(understandMaxBytes);
    const audioPath = createOversizedLongAudioFixture(workDir, understandMaxBytes);
    expect(statSync(audioPath).size).toBeGreaterThan(understandMaxBytes);
    expect(statSync(audioPath).size).toBeLessThanOrEqual(understandLongMediaMaxBytes);

    await roomForUploads(1);
    const uploadFinished = watchQueuedFinish(page);
    await dropFile(page, 'long-audio.wav', 'audio/wav', readFileSync(audioPath));
    const { delivered } = await uploadFinished;
    await expect.poll(async () => (await canvasState(page)).nodes.some((node) =>
      node.type === 'audio' && node.data.content === delivered.fileUrl),
    { timeout: 120_000 }).toBe(true);

    const source = (await canvasState(page)).nodes.find((node) =>
      node.type === 'audio' && node.data.content === delivered.fileUrl);
    if (source === undefined) throw new Error('the uploaded audio node is missing');
    const sourceNode = visibleSpace(page).locator(`.react-flow__node[data-id="${source.id}"]`);
    await expect(sourceNode).toBeVisible();
    await sourceNode.click({ button: 'right' });

    const understandItem = page.getByTestId('node-menu-understand');
    await expect(understandItem).not.toHaveAttribute('data-disabled');
    const responsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/api/v1/canvas/understand') &&
      response.request().method() === 'POST',
    );
    await understandItem.click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const { data: { task_id: taskId } } = await response.json() as { data: { task_id: string } };

    const task = await completedUnderstandTask(page, taskId);
    expect(task.result.finish_reason).toBe('stop');
    expect(task.result.outputs).toHaveLength(1);
    const written = task.result.outputs[0].content;
    expect(written.trim().length).toBeGreaterThan(0);

    const resultNode = (await canvasState(page)).nodes.find((node) => node.id !== source.id && node.type === 'text');
    if (resultNode === undefined) throw new Error('the understanding result node is missing');
    await expect.poll(async () => (await canvasState(page)).nodes.find((node) => node.id === resultNode.id)?.bodyText)
      .toBe(written);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('understands an oversized uploaded video and writes its result @needs-model @needs-internet @needs-storage @needs-ingest @needs-ffmpeg', async ({ page }) => {
  test.setTimeout(600_000);
  const workDir = mkdtempSync(join(tmpdir(), 'breatic-long-video-understand-'));
  try {
    const limitsResponse = await page.request.get('/api/v1/canvas/limits');
    expect(limitsResponse.status()).toBe(200);
    const { data: { understandMaxBytes, understandLongMediaMaxBytes } } = await limitsResponse.json() as {
      data: { understandMaxBytes: number; understandLongMediaMaxBytes: number };
    };
    expect(understandLongMediaMaxBytes).toBeGreaterThan(understandMaxBytes);

    const videoPath = createOversizedLongVideoFixture(workDir, understandMaxBytes);
    const videoSize = statSync(videoPath).size;
    expect(videoSize).toBeGreaterThan(understandMaxBytes);
    expect(videoSize).toBeLessThanOrEqual(understandLongMediaMaxBytes);

    await roomForUploads(1);
    const uploadFinished = watchQueuedFinish(page);
    await dropFile(page, 'long-video.mp4', 'video/mp4', readFileSync(videoPath));
    const { delivered } = await uploadFinished;
    await expect.poll(async () => (await canvasState(page)).nodes.some((node) =>
      node.type === 'video' && node.data.content === delivered.fileUrl),
    { timeout: 120_000 }).toBe(true);

    const source = (await canvasState(page)).nodes.find((node) =>
      node.type === 'video' && node.data.content === delivered.fileUrl);
    if (source === undefined) throw new Error('the uploaded video node is missing');
    const sourceNode = visibleSpace(page).locator(`.react-flow__node[data-id="${source.id}"]`);
    await expect(sourceNode).toBeVisible();
    await sourceNode.click({ button: 'right' });

    const understandItem = page.getByTestId('node-menu-understand');
    await expect(understandItem).not.toHaveAttribute('data-disabled');
    const responsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/api/v1/canvas/understand') &&
      response.request().method() === 'POST',
    );
    await understandItem.click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const { data: { task_id: taskId } } = await response.json() as { data: { task_id: string } };

    const task = await completedUnderstandTask(page, taskId);
    expect(task.result.finish_reason).toBe('stop');
    expect(task.result.outputs).toHaveLength(1);
    const written = task.result.outputs[0].content;
    expect(written.trim().length).toBeGreaterThan(0);

    const resultNode = (await canvasState(page)).nodes.find((node) => node.id !== source.id && node.type === 'text');
    if (resultNode === undefined) throw new Error('the understanding result node is missing');
    await expect.poll(async () => (await canvasState(page)).nodes.find((node) => node.id === resultNode.id)?.bodyText)
      .toBe(written);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
