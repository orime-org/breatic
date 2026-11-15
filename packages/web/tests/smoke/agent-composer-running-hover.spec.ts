// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the composer's two buttons say on hover while a reply runs
 * (inner#1717). Send's label is long and sits over the stop button beside it,
 * so moving from one to the other is what this looks at: where a tooltip may
 * be hovered, the pointer on its way to stop counted as on its way to send's
 * label, which stayed up while stop's never opened. Radix works that out from
 * the drawn layout, so only a real browser shows it.
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { answerRuns, holdRunStreams } from '../helpers/fake-run';
import { openSmokeProject } from '../helpers/project';

/** A finished run the way the server writes one, after its heartbeat. */
const FINISHED_RUN = [
  { type: 'start', messageId: 'm-running-hover' },
  { type: 'start-step' },
  { type: 'text-start', id: 't0' },
  { type: 'text-delta', id: 't0', delta: 'Done.' },
  { type: 'text-end', id: 't0' },
  { type: 'finish-step' },
  { type: 'finish' },
];

/**
 * Move the pointer onto a button the way a mouse does, through the points in
 * between, rather than appearing on it in one event.
 * @param page - The page.
 * @param testId - The button.
 */
async function glideTo(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} is not on screen`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
}

test('pointing at send then at stop while a reply runs shows what each one does', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const release = await holdRunStreams(page);
    await openSmokeProject(page);
    await startNewConversation(page);
    await answerRuns(page, () => FINISHED_RUN);
    const box = page.getByTestId('chat-composer-box');
    await box.fill('hello');
    await box.press('Enter');
    await expect(page.getByTestId('chat-composer-abort')).toBeVisible({ timeout: 15_000 });

    await glideTo(page, 'chat-composer-send');
    await expect(page.getByRole('tooltip')).toHaveText(['Send · The Agent reads it at its next step']);
    await glideTo(page, 'chat-composer-abort');
    await expect(page.getByRole('tooltip')).toHaveText(['Stop']);
    await glideTo(page, 'chat-composer-send');
    await expect(page.getByRole('tooltip')).toHaveText(['Send · The Agent reads it at its next step']);

    await release();
    await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.close();
  }
});
