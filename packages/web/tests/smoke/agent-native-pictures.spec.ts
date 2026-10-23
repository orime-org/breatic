// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { openSmokeProject } from '../helpers/project';
import { uniquePicture, watchQueuedFinish } from '../helpers/upload';
import { roomForUploads } from '../helpers/upload-budget';

test.use({ viewport: { width: 1400, height: 900 } });

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
  await page.getByTestId('chat-composer-file-input').setInputFiles({
    name: 'sample.jpg',
    mimeType: 'image/jpeg',
    buffer: uniquePicture(readFileSync(join(__dirname, '../fixtures/exif6-red-top.jpg'))),
  });
  const { delivered } = await upload;
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
