// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The approved transcription journey, from a node menu to its downstream text (inner#856). */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { registerCanvasStage, seedNode } from '../helpers/audio-panel';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { visibleSpace } from '../helpers/space';
import { dropFile } from '../helpers/upload';
import { roomForUploads } from '../helpers/upload-budget';

registerCanvasStage();
test.use({ viewport: { width: 1680, height: 1050 } });

/** The graph fields this journey observes. */
interface Graph {
  nodes: { id: string; type: string; data: { content?: string; name?: string } }[];
  edges: { source: string; target: string }[];
}

/**
 * Open the real menu and its transcription panel.
 * @param page - The signed-in page.
 * @param nodeId - The source node.
 */
async function openTranscribe(page: Page, nodeId: string): Promise<void> {
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible();
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-transcribe').click();
  await expect(visibleSpace(page).getByTestId('transcribe-panel')).toBeVisible();
  await expect(page.getByTestId('node-menu-transcribe')).toHaveCount(0);
}

/**
 * Read the graph from the module that owns the displayed document.
 * @param page - The page inside the test's Project and Space.
 * @returns The node ids and connection endpoints.
 * @throws {Error} When the displayed Project or Space is missing.
 */
async function graph(page: Page): Promise<Graph> {
  const projectId = /([0-9a-f-]{36})$/.exec(page.url())?.[1];
  const spaceId = await visibleSpace(page).getAttribute('data-space-outlet');
  if (projectId === undefined || spaceId === null) throw new Error('no displayed Project or Space');
  const url = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(async ({ projectId, spaceId, url }) => {
    const canvas = await import(/* @vite-ignore */ url) as {
      readCanvasGraph: (projectId: string, spaceId: string) => Graph;
    };
    return canvas.readCanvasGraph(projectId, spaceId);
  }, { projectId, spaceId, url });
}

test('Run carries the filler choice and builds one connected, selected text node with one undo', async ({ page }) => {
  const id = randomUUID();
  const source = readFileSync(resolve(__dirname, '../fixtures/voice.mp3'));
  await seedNode(id, 'audio', `data:audio/mpeg;base64,${source.toString('base64')}`);
  await openTranscribe(page, id);
  await expect(page.getByTestId('transcribe-keep-fillers')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('transcribe-keep-fillers').click();
  await expect(page.getByTestId('transcribe-hint')).toHaveText(
    'Leaves out um, uh and the like, and may reword a few others',
  );
  let sent: Record<string, unknown> | undefined;
  await page.route('**/canvas/transcribe', async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    // A terminal response keeps this UI-only case away from the model.
    await route.fulfill({ status: 422, json: { error: { code: 'test_refusal', message: 'Test refusal' } } });
  });
  await page.getByTestId('transcribe-run').click();
  await expect.poll(() => sent).toMatchObject({ source_type: 'audio', keep_fillers: false });
  const built = (await graph(page)).nodes.find((node) => node.id !== id);
  expect(built?.type).toBe('text');
  expect(built?.data.name).toBe('TRANSCRIBE-audio-e2e');
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${built!.id}"]`);
  await expect(node).toBeVisible();
  await expect(node).toHaveClass(/selected/);
  await expect(page.getByTestId('transcribe-panel')).toHaveCount(0);
  expect((await graph(page)).edges).toMatchObject([{ source: id, target: built!.id }]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await graph(page)).nodes.map((node) => node.id)).toEqual([id]);
  expect((await graph(page)).edges).toEqual([]);
});

for (const format of ['m4a', 'webm', 'mp4', 'no-speech'] as const) {
  test(`transcribes ${format} through the real worker and collab @needs-model @needs-storage @needs-ingest @needs-ffmpeg`, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'breatic-transcribe-'));
    try {
      const extension = format === 'no-speech' ? 'mp3' : format;
      const file = join(dir, `source.${extension}`);
      // Synthesized meeting speech with a known original, retained as a fixed fixture.
      const speech = resolve(__dirname, '../fixtures/transcribe-meeting.mp3');
      const input = format === 'no-speech'
        ? ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3']
        : format === 'mp4'
          ? ['-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=15', '-i', speech, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']
          : ['-i', speech];
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input, '-metadata', `comment=${randomUUID()}`, file]);
      await roomForUploads(1);
      await dropFile(page, `source.${extension}`, format === 'mp4' ? 'video/mp4' : `audio/${format === 'no-speech' ? 'mpeg' : format === 'm4a' ? 'mp4' : 'webm'}`, readFileSync(file));
      await expect.poll(async () => (await graph(page)).nodes.filter((node) => node.data.content?.startsWith('https://')).length, { timeout: 120_000 }).toBe(1);
      const source = (await graph(page)).nodes[0]!;
      await openTranscribe(page, source.id);
      await page.screenshot({ path: test.info().outputPath('transcribe-panel.png') });
      const request = page.waitForResponse((response) => response.url().endsWith('/canvas/transcribe') && response.request().method() === 'POST');
      await page.getByTestId('transcribe-run').click();
      expect((await request).status()).toBe(201);
      const built = (await graph(page)).nodes.find((node) => node.id !== source.id)!;
      const text = visibleSpace(page).locator(`.react-flow__node[data-id="${built.id}"]`);
      await expect(text).toBeVisible();
      if (format === 'no-speech') {
        await expect(text.getByTestId('task-count-failed')).toBeVisible({ timeout: 120_000 });
        await text.getByTestId('task-count-failed').click();
        await expect(page.getByTestId('node-task-row')).toContainText('No one speaks in this audio.');
        await expect(text.getByTestId('text-node-body')).toHaveCount(0);
      } else {
        await expect(text).toContainText(/let.s start the meeting/i, { timeout: 120_000 });
        await expect(text).toContainText(/budget for the next quarter is \$12,000/i);
        await expect(text).toContainText(/we ship the new editor on Friday/i);
        await expect(text.getByTestId('task-count-done')).toBeVisible();
        await text.getByTestId('task-count-done').click();
      }
      await expect(page.getByTestId('task-kind')).toHaveText('Transcribe');
      await expect(page.getByTestId('task-detail')).toContainText('Gemini');
      await page.screenshot({ path: test.info().outputPath('transcribe-result.png') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
