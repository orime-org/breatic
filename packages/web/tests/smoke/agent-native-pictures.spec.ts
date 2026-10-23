// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import type { ChatAttachedChip } from '@breatic/shared';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { dropFile, uniquePicture, watchQueuedFinish } from '../helpers/upload';
import { roomForUploads } from '../helpers/upload-budget';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';

test.use({ viewport: { width: 1400, height: 900 } });

/** A stored conversation part as the public conversation endpoint returns it. */
interface StoredPart {
  type: string;
  state?: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

/**
 * Upload the fixed neutral-named sample onto a fresh canvas through the real path.
 * @param page - The page showing this case's empty canvas.
 * @returns The actual node id and canonical URL delivered by registration.
 * @throws {Error} when the canvas upload produces no identifiable node.
 */
async function uploadCanvasSample(page: Page): Promise<{ nodeId: string; fileUrl: string }> {
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  await roomForUploads(1);
  const upload = watchQueuedFinish(page);
  await dropFile(page, 'sample.jpg', 'image/jpeg', uniquePicture(readFileSync(join(__dirname, '../fixtures/exif6-red-top.jpg'))));
  const { delivered } = await upload;
  const node = visibleSpace(page).locator('.react-flow__node[data-id]');
  await expect(node).toHaveCount(1, { timeout: 120_000 });
  await expect(node.getByTestId('image-node-img')).toBeVisible({ timeout: 30_000 });
  const nodeId = await node.getAttribute('data-id');
  if (nodeId === null) throw new Error('the uploaded image node has no id');
  return { nodeId, fileUrl: delivered.fileUrl };
}

/**
 * Send a real Agent turn and return the precise request and stored tool records.
 * @param page - The page holding this case's fresh conversation.
 * @param prompt - The question, without any answer-bearing image description.
 * @returns The submitted chips, visible answer and stored message parts.
 * @throws {Error} when the actual request, reply or stored conversation cannot be read.
 */
async function askAboutPictures(page: Page, prompt: string): Promise<{ chips: ChatAttachedChip[]; reply: string; parts: StoredPart[] }> {
  const request = page.waitForRequest((sent) => sent.method() === 'POST' && sent.url().endsWith('/api/v1/chat/message'));
  await page.getByTestId('chat-composer-box').fill(prompt);
  await page.getByTestId('chat-composer-box').press('Enter');
  const body = (await request).postDataJSON() as { conversation_id: string; attached_chips: ChatAttachedChip[] };
  const abort = page.getByTestId('chat-composer-abort');
  await expect(abort).toBeVisible({ timeout: 60_000 });
  await expect(abort).toHaveCount(0, { timeout: 180_000 });
  const answer = page.locator('[data-testid="markdown-body"]').last();
  await expect(answer).toBeVisible({ timeout: 20_000 });
  const stored = await page.request.get(`/api/v1/chat/conversations/${body.conversation_id}`);
  expect(stored.ok(), `conversation read: ${String(stored.status())}`).toBe(true);
  const { messages } = ((await stored.json()) as { data: { messages: Array<{ parts: StoredPart[] }> } }).data;
  return { chips: body.attached_chips, reply: await answer.innerText(), parts: messages.flatMap((message) => message.parts) };
}

test('reads an attached JPEG directly with the main model @needs-model @needs-storage @needs-ingest', async ({ page }) => {
  // Real upload, upright conversion, JPEG preparation and one model answer may each wait on their external service.
  test.setTimeout(300_000);
  await openSmokeProject(page);
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('chat-composer-attach')).toBeEnabled({ timeout: 20_000 });
  await roomForUploads(1);

  // This fixed fixture has two solid bands, red above blue when upright.
  // The neutral filename and question reveal neither color or its position.
  // A fresh JPEG comment avoids deduping an earlier case's stored transform.
  const upload = watchQueuedFinish(page);
  const uploadPart = page.waitForRequest((sent) => sent.method() === 'PUT' && new URL(sent.url()).pathname.startsWith('/uploads/'));
  await page.getByTestId('chat-composer-file-input').setInputFiles({
    name: 'sample.jpg',
    mimeType: 'image/jpeg',
    buffer: uniquePicture(readFileSync(join(__dirname, '../fixtures/exif6-red-top.jpg'))),
  });
  const { delivered } = await upload;
  await test.info().attach('upload-worker-origin.json', {
    body: Buffer.from(JSON.stringify({ origin: new URL((await uploadPart).url()).origin })),
    contentType: 'application/json',
  });
  expect(delivered.fileUrl).toMatch(/_upright\.[a-z]+$/);
  await expect(page.getByTestId('chat-composer-chips').locator('[data-status]')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });

  const request = page.waitForRequest((sent) => sent.method() === 'POST' && sent.url().endsWith('/api/v1/chat/message'));
  await page.getByTestId('chat-composer-box').fill(
    'Inspect the attached image directly. Name the large color band at the top and the large color band at the bottom. ' +
      'Reply in English using exactly Top: COLOR; Bottom: COLOR. Do not call a tool.',
  );
  await page.getByTestId('chat-composer-box').press('Enter');
  const conversationId = ((await request).postDataJSON() as { conversation_id: string }).conversation_id;
  const abort = page.getByTestId('chat-composer-abort');
  await expect(abort).toBeVisible({ timeout: 60_000 });
  await expect(abort).toHaveCount(0, { timeout: 180_000 });

  const answer = page.locator('[data-testid="markdown-body"]').last();
  await expect(answer).toBeVisible({ timeout: 20_000 });
  await expect(answer).toHaveText(/Top:\s*red\s*;\s*Bottom:\s*blue\.?/i);
  const stored = await page.request.get(`/api/v1/chat/conversations/${conversationId}`);
  expect(stored.ok(), `conversation read: ${String(stored.status())}`).toBe(true);
  const { messages } = ((await stored.json()) as {
    data: { messages: Array<{ parts: Array<{ type: string }> }> };
  }).data;
  expect(messages.flatMap((message) => message.parts).filter((part) => part.type === 'tool-understand_media')).toEqual([]);
});

test('reads a canvas picture added to Agent through its node menu @needs-model @needs-storage @needs-ingest', async ({ page }) => {
  test.setTimeout(300_000); // A real canvas upload and JPEG preparation precede a model turn of up to three minutes.
  let spaceId = '';
  try {
    await openSmokeProject(page);
    spaceId = await createSpace(page, 'canvas', `agent-picture-${Date.now()}`);
    const uploaded = await uploadCanvasSample(page);
    await startNewConversation(page);
    await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
    // The fresh canvas holds one node, so the menu cannot target an overlapping sibling.
    const node = visibleSpace(page).locator(`.react-flow__node[data-id="${uploaded.nodeId}"]`);
    await node.click({ button: 'right' });
    await page.getByTestId('node-menu-add-to-agent').click();
    await expect(page.locator('[data-testid^="chat-chip-"]')).toHaveCount(1, { timeout: 20_000 });

    const result = await askAboutPictures(page,
      'Inspect the picture in the canvas attachment directly. Name the large color band at the top and the large color band at the bottom. ' +
      'Reply in English using exactly Top: COLOR; Bottom: COLOR. Do not call a tool.',
    );

    expect(result.chips).toHaveLength(1);
    expect(result.chips[0]).toMatchObject({ type: 'canvas', data_snapshot: { nodes: [expect.objectContaining({
      id: uploaded.nodeId, type: 'image', data: expect.objectContaining({ content: uploaded.fileUrl }),
    })] } });
    expect(result.reply).toMatch(/Top:\s*red\s*;\s*Bottom:\s*blue\.?/i);
    expect(result.parts.filter((part) => part.type.startsWith('tool-'))).toEqual([]);
  } finally {
    if (spaceId !== '') await deleteSpace(page, spaceId);
  }
});

test('reads a node history picture version with the main model @needs-model @needs-storage @needs-ingest', async ({ page }) => {
  test.setTimeout(300_000); // A real upload and history read prepare JPEG bytes before a model turn of up to three minutes.
  let spaceId = '';
  try {
    await openSmokeProject(page);
    spaceId = await createSpace(page, 'canvas', `agent-history-picture-${Date.now()}`);
    const uploaded = await uploadCanvasSample(page);
    const projectId = smokeProjectId();
    await expect.poll(async () => {
      const history = await page.request.get(`/api/v1/canvas/nodes/${uploaded.nodeId}/history`, {
        params: { project_id: projectId, limit: 10, offset: 0 },
      });
      expect(history.ok(), `history read: ${String(history.status())}`).toBe(true);
      const { entries } = ((await history.json()) as { data: { entries: Array<{ content: string | null }> } }).data;
      return entries.map((version) => version.content);
    }, { timeout: 30_000 }).toEqual([uploaded.fileUrl]);
    await startNewConversation(page);
    await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('chat-composer-chips')).toHaveCount(0);

    const result = await askAboutPictures(page,
      `Call read_node_history once for node_id ${uploaded.nodeId}. Inspect the returned version picture. ` +
      'Name the large color band at the top and the large color band at the bottom. ' +
      'Reply in English using exactly Top: COLOR; Bottom: COLOR. Do not call any other tool.',
    );

    expect(result.chips).toEqual([]);
    const calls = result.parts.filter((part) => part.type === 'tool-read_node_history');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ state: 'output-available', input: { node_id: uploaded.nodeId } });
    expect(calls[0].output).toMatchObject({ kind: 'agent-pictures-v1', pictures: [{
      label: expect.stringContaining(uploaded.nodeId), sourceUrl: uploaded.fileUrl,
      url: expect.stringMatching(/\.agent-v1-\d+-q\d+\.jpg$/), sizeBytes: expect.any(Number), mediaType: 'image/jpeg',
    }] });
    expect(result.reply).toMatch(/Top:\s*red\s*;\s*Bottom:\s*blue\.?/i);
    expect(result.parts.filter((part) => part.type.startsWith('tool-')).map((part) => part.type)).toEqual(['tool-read_node_history']);
  } finally {
    if (spaceId !== '') await deleteSpace(page, spaceId);
  }
});

test('compares two searched pictures using their prepared JPEGs @needs-model @needs-search @needs-internet @needs-storage @needs-ingest', async ({ page }) => {
  test.setTimeout(420_000); // Real search and two edge JPEG preparations precede the model's comparison step.
  await openSmokeProject(page);
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  const request = page.waitForRequest((sent) => sent.method() === 'POST' && sent.url().endsWith('/api/v1/chat/message'));
  const result = await askAboutPictures(page,
    'Call search_images exactly once with count 2. Search for simple colorful abstract geometric compositions. ' +
    'Inspect the two returned pictures directly, using their visible content rather than their titles. ' +
    'Under the labels Picture 1 and Picture 2, describe each picture\'s dominant large color areas, shapes and their positions. ' +
    'Then write Choice: Picture 1 or Choice: Picture 2, selecting the picture closer to a centered-circle composition, ' +
    'with a reason based on what you can actually see. Do not call any other tool.',
  );
  const conversationId = ((await request).postDataJSON() as { conversation_id: string }).conversation_id;
  const calls = result.parts.filter((part) => part.type.startsWith('tool-'));
  expect(calls.map((part) => part.type)).toEqual(['tool-search_images']);
  expect(calls[0]).toMatchObject({ state: 'output-available', input: { count: 2 } });
  const output = calls[0].output as {
    images: Array<{ thumbnailUrl: string }>;
    forModel: { kind: string; pictures: Array<{ label: string; sourceUrl: string; url: string; sizeBytes: number; mediaType: string }> };
  };
  expect(output.forModel.kind).toBe('agent-pictures-v1');
  expect(output.forModel.pictures.length).toBeGreaterThanOrEqual(2);
  const pictures = output.forModel.pictures.slice(0, 2);
  expect(pictures.map((picture) => picture.sourceUrl)).toEqual(output.images.slice(0, 2).map((image) => image.thumbnailUrl));
  for (const picture of pictures) {
    expect(picture).toMatchObject({
      label: expect.any(String), sourceUrl: expect.stringMatching(/^https:\/\//),
      url: expect.stringMatching(/^https:\/\/.+\.agent-v1-\d+-q\d+\.jpg$/),
      mediaType: 'image/jpeg', sizeBytes: expect.any(Number),
    });
    expect(picture.sizeBytes).toBeGreaterThan(0);
    // sourceUrl remains the real search thumbnail. The URL read here is the
    // registered source's prepared JPEG, whose bytes must actually be served.
    const served = await page.request.get(picture.url);
    expect(served.ok(), `prepared JPEG read: ${String(served.status())}`).toBe(true);
    expect(served.headers()['content-type']).toMatch(/^image\/jpeg\b/i);
    expect((await served.body()).subarray(0, 3).toString('hex')).toBe('ffd8ff');
  }
  expect(result.reply).toMatch(/Picture\s*1/i);
  expect(result.reply).toMatch(/Picture\s*2/i);
  expect(result.reply).toMatch(/Choice:\s*Picture\s*[12]/i);
  // These format and wire assertions are not a semantic verdict. A reviewer
  // must view both prepared JPEGs and compare the reported colors, shapes,
  // positions and choice reason with the actual pictures before accepting it.
  // Only conversation data and public picture URLs are attached, never
  // request headers, browser storage, configuration or authentication state.
  await test.info().attach('searched-picture-comparison.json', {
    body: Buffer.from(JSON.stringify({
      conversationId,
      answer: result.reply,
      parts: result.parts,
      pictures,
      semanticReview: 'Compare both prepared JPEGs with the reported colors, shapes, positions and Choice reason.',
    }, null, 2)),
    contentType: 'application/json',
  });
});

test('reads an external PNG served at a bin URL through a canvas attachment @needs-model @needs-internet @needs-storage @needs-ingest', async ({ page }) => {
  test.setTimeout(300_000); // The Worker imports and registers an external source, prepares its JPEG, then the main model answers.
  // The public image CDN serves OpenCV's fixed left01 sample as a clear
  // 640x480 image/png at /image.bin. The neutral filename reveals no object.
  const sourceUrl = 'https://images.weserv.nl/image.bin?url=raw.githubusercontent.com/opencv/opencv/4ffd42f66ae8e554819d86647753f2cec6380748/samples/data/left01.jpg&output=png';
  expect(new URL(sourceUrl).pathname.endsWith('.bin')).toBe(true);
  let spaceId = '';
  try {
    await openSmokeProject(page);
    spaceId = await createSpace(page, 'canvas', `agent-external-picture-${Date.now()}`);
    await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    const moduleUrl = await liveModuleUrl(page, CANVAS_SPACE);
    const nodeId = await page.evaluate(async ({ at, projectId, canvasId, content }) => {
      const canvas = await import(/* @vite-ignore */ at) as {
        addNode: (project: string, space: string, node: unknown) => void;
        readCanvasGraph: (project: string, space: string) => { nodes: Array<{ id: string }> };
      };
      const id = crypto.randomUUID();
      canvas.addNode(projectId, canvasId, {
        id, type: 'image', position: { x: 0, y: 0 },
        data: { name: 'sample', content, createdAt: Date.now(), createdBy: 'agent-picture-e2e', locked: false, attachments: [] },
      });
      if (!canvas.readCanvasGraph(projectId, canvasId).nodes.some((node) => node.id === id)) {
        throw new Error('the live canvas did not retain its image node');
      }
      return id;
    }, { at: moduleUrl, projectId: smokeProjectId(), canvasId: spaceId, content: sourceUrl });
    const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(node).toBeVisible({ timeout: 20_000 });
    await startNewConversation(page);
    await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
    await node.click({ button: 'right' });
    await page.getByTestId('node-menu-add-to-agent').click();
    await expect(page.locator('[data-testid^="chat-chip-"]')).toHaveCount(1, { timeout: 20_000 });

    const result = await askAboutPictures(page,
      'Describe the visible object or objects in the attached picture in English. Inspect it directly; do not call tools.',
    );

    await test.info().attach('external-bin-picture.json', {
      body: Buffer.from(JSON.stringify({ sourceUrl, answer: result.reply, parts: result.parts }, null, 2)),
      contentType: 'application/json',
    });
    expect(result.chips).toHaveLength(1);
    expect(result.chips[0]).toMatchObject({ type: 'canvas', data_snapshot: { nodes: [expect.objectContaining({
      id: nodeId, type: 'image', data: expect.objectContaining({ name: 'sample', content: sourceUrl }),
    })] } });
    expect(result.parts.filter((part) => part.type.startsWith('tool-'))).toEqual([]);
    // The fixed photograph shows a person holding a large black-and-white
    // checkerboard. Neither the question nor the neutral node name says so.
    expect(result.reply).toMatch(/checkerboard|chessboard|checkered\s+board/i);
    expect(result.reply).toMatch(/black[\s\S]*white|white[\s\S]*black/i);
  } finally {
    if (spaceId !== '') await deleteSpace(page, spaceId);
  }
});
