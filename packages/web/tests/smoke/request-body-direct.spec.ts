// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Bodies within the request limit go as they are (inner#1006 SM4).
 *
 * The baseline beside `request-body-transfer.spec.ts`: a 10 KB text node
 * pasted and kept as a snapshot, and a short chat message, ask for no
 * transfer ticket and send the body itself, in the shape each route has
 * always read. The chat request is held and never answered, so no model is
 * reached; this file needs no outside service.
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { randomUUID } from 'node:crypto';

import { expect } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import {
  CHAT_MESSAGE,
  PASTE,
  SNAPSHOT,
  TRANSFER_TICKET,
  addTextNode,
  copyAndPaste,
  keepSnapshot,
  nodeIds,
  recordPage,
  sentTo,
} from '../helpers/request-bodies';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { startNewConversation } from '../helpers/conversation';

test.use({ viewport: { width: 1500, height: 900 } });

/** A text node of about 10 KB, well within the limit. */
const SMALL_WORDS = `Small words ${'x'.repeat(10_000)}`;

test('SM4 a 10 KB paste, its snapshot and a short chat message send their bodies directly, with no transfer', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const record = recordPage(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'canvas', `direct-bodies-${Date.now()}`);
  try {
    await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    const original = randomUUID();
    await addTextNode(page, { projectId, spaceId, nodeId: original }, SMALL_WORDS);
    const before = await nodeIds(page, projectId, spaceId);

    const pasted = page.waitForResponse((r) => new URL(r.url()).pathname === PASTE && r.request().method() === 'POST');
    await copyAndPaste(page, original);
    const pasteAnswer = await pasted;
    expect(pasteAnswer.status()).toBe(200);
    await expect.poll(async () => (await nodeIds(page, projectId, spaceId)).length, { timeout: 20_000 }).toBe(before.length + 1);
    const copy = (await nodeIds(page, projectId, spaceId)).find((id) => !before.includes(id)) ?? '';
    const pasteBody = pasteAnswer.request().postDataJSON() as {
      project_id: string;
      history: Array<{ node_id: string; kind: string; content: string }>;
    };
    expect(pasteBody.project_id).toBe(projectId);
    expect(pasteBody.history).toEqual([{ node_id: copy, kind: 'text', content: SMALL_WORDS }]);

    const kept = page.waitForResponse((r) => new URL(r.url()).pathname === SNAPSHOT && r.request().method() === 'POST');
    await keepSnapshot(page, original);
    const snapshotAnswer = await kept;
    expect(snapshotAnswer.status()).toBe(201);
    expect(snapshotAnswer.request().postDataJSON()).toEqual({ project_id: projectId, node_id: original, text: SMALL_WORDS });

    // Held, never answered: what is read is what the box sent.
    await page.route(`**${CHAT_MESSAGE}`, () => undefined);
    await startNewConversation(page);
    const asked = page.waitForRequest((r) => new URL(r.url()).pathname === CHAT_MESSAGE && r.method() === 'POST');
    await page.getByTestId('chat-composer-box').fill('A short question.');
    await page.getByTestId('chat-composer-box').press('Enter');
    const chatBody = (await asked).postDataJSON() as { message: string; project_id: string };
    expect([chatBody.message, chatBody.project_id]).toEqual(['A short question.', projectId]);

    expect(sentTo(record, TRANSFER_TICKET)).toEqual([]);
    await test.info().attach('requests.json', {
      body: Buffer.from(JSON.stringify(record.requests, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    await deleteSpace(page, spaceId);
  }
});
