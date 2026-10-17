// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A project at the Space cap, end to end (inner#1158).
 *
 * At 200 Spaces the new-Space button and the activity panel's Restore stay
 * reachable by keyboard but do nothing except say why: hovering shows the
 * limit, pressing shows it as a one-line warning toast. Deleting a Space makes
 * room again.
 *
 * The case makes its own project and fills it through the Space RPC the page
 * already holds (the same `space:create` the dialog sends), so the slot's
 * shared project never fills up for the cases after this one. The project is
 * archived at the end.
 *
 *   pnpm --filter @breatic/web test:smoke space-cap
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { liveModuleUrl, YJS_MANAGER } from '../helpers/live-module';
import { archiveProjects } from '../helpers/project';

/** `MAX_SPACES_PER_PROJECT` in `@breatic/shared`. */
const CAP = 200;

const LIMIT_TEXT = `Reached the limit of ${CAP} Spaces`;

/**
 * Number of Spaces the drawer trigger shows.
 * @param page - The project page.
 * @returns The count.
 */
async function spaceCount(page: Page): Promise<number> {
  const text = await page.getByTestId('space-drawer-trigger').innerText();
  return Number(text.replace(/\D/g, ''));
}

/**
 * Send Space RPCs over the meta connection the page already holds.
 * @param page - The project page.
 * @param projectId - The project.
 * @param requests - The requests, sent one after another.
 * @returns The ids of the Spaces the creates made.
 * @throws {Error} When the server refuses one of them.
 */
async function sendRpcs(
  page: Page,
  projectId: string,
  requests: ReadonlyArray<{ type: string; payload: Record<string, string> }>,
): Promise<string[]> {
  const urls = {
    socket: await liveModuleUrl(page, 'data/yjs/collab-socket.tsx'),
    manager: await liveModuleUrl(page, YJS_MANAGER),
    rpc: await liveModuleUrl(page, 'data/yjs/space-rpc-client.ts'),
  };
  return page.evaluate(
    async ({ urls, metaName, requests }) => {
      const { acquireDocProvider, releaseDocProvider } = await import(/* @vite-ignore */ urls.socket);
      const { getDoc } = await import(/* @vite-ignore */ urls.manager);
      const { sendSpaceRpc } = await import(/* @vite-ignore */ urls.rpc);
      const provider = acquireDocProvider(metaName, getDoc(metaName));
      const made: string[] = [];
      try {
        for (const request of requests) {
          const res = await sendSpaceRpc(provider, request);
          if (!res.ok) throw new Error(`${request.type}: ${res.error.code}`);
          if (res.result?.spaceId) made.push(res.result.spaceId);
        }
      } finally {
        releaseDocProvider(metaName);
      }
      return made;
    },
    { urls, metaName: `project-${projectId}/meta`, requests },
  );
}

/**
 * `count` canvas creates.
 * @param count - How many.
 * @returns The requests.
 */
function creates(count: number): Array<{ type: string; payload: Record<string, string> }> {
  return Array.from({ length: count }, (_, i) => ({
    type: 'space:create',
    payload: { type: 'canvas', name: `Cap ${i}`, claimToken: crypto.randomUUID() },
  }));
}

/**
 * The warning toast on screen, settled.
 * @param page - The project page.
 * @returns Its text.
 */
async function warningToastText(page: Page): Promise<string> {
  const toast = page.locator('[data-sonner-toast][data-type="warning"]').last();
  await expect(toast).toBeVisible({ timeout: 10_000 });
  return toast.innerText();
}

test('a project at the Space cap says why it cannot take another one', async ({ page }) => {
  test.setTimeout(240_000);
  const studios = await dataOf<Array<{ id: string; type: string }>>(
    await page.request.get('/api/v1/studios'),
    'list studios',
  );
  const personal = studios.find((s) => s.type === 'personal');
  expect(personal, 'A has no personal studio').toBeDefined();
  const stamp = Date.now();
  const project = await dataOf<{ id: string }>(
    await page.request.post('/api/v1/projects', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { studioId: personal!.id, name: `Space cap ${stamp}`, slug: `space-cap-${stamp}`, spaceType: 'canvas' },
    }),
    'create project',
  );

  try {
    await page.goto(`/project/${project.id}`);
    await page.getByTestId('space-drawer-trigger').waitFor({ timeout: 60_000 });
    const start = await spaceCount(page);
    const made = await sendRpcs(page, project.id, creates(CAP - start));
    await expect.poll(() => spaceCount(page), { timeout: 30_000 }).toBe(CAP);

    await test.step('the new-Space button is reachable, explains on hover and on Enter, and opens nothing', async () => {
      const plus = page.getByTestId('new-space-button');
      await expect(plus).toHaveAttribute('aria-disabled', 'true');
      await plus.hover();
      await expect(page.getByRole('tooltip')).toHaveText(LIMIT_TEXT);
      await page.mouse.move(10, 10);
      await plus.focus();
      await expect(plus).toBeFocused();
      await page.keyboard.press('Enter');
      expect(await warningToastText(page)).toBe(LIMIT_TEXT);
      await expect(page.getByTestId('new-space-dialog')).toHaveCount(0);
    });

    await test.step('Restore is reachable, explains on hover and on press, and restores nothing', async () => {
      await sendRpcs(page, project.id, [{ type: 'space:delete', payload: { spaceId: made[0] } }]);
      await sendRpcs(page, project.id, creates(1));
      await expect.poll(() => spaceCount(page), { timeout: 30_000 }).toBe(CAP);
      await page.getByTestId('project-activity-trigger').click();
      const restore = page.locator('[data-testid^="project-activity-restore-"]').first();
      await expect(restore).toHaveAttribute('aria-disabled', 'true');
      await restore.hover();
      await expect(page.getByRole('tooltip')).toHaveText(LIMIT_TEXT);
      // Playwright's click waits for an enabled element and reads aria-disabled
      // as disabled, so the press goes through the keyboard, as a keyboard
      // user would make it.
      await restore.focus();
      await expect(restore).toBeFocused();
      await page.keyboard.press('Enter');
      expect(await warningToastText(page)).toBe(LIMIT_TEXT);
      expect(await spaceCount(page)).toBe(CAP);
      await page.keyboard.press('Escape');
    });

    await test.step('deleting a Space makes the button available again', async () => {
      await sendRpcs(page, project.id, [{ type: 'space:delete', payload: { spaceId: made[1] } }]);
      await expect.poll(() => spaceCount(page), { timeout: 30_000 }).toBe(CAP - 1);
      await expect(page.getByTestId('new-space-button')).not.toHaveAttribute('aria-disabled', 'true');
    });
  } finally {
    expect(await archiveProjects(page.request, [project.id]), 'project left live').toEqual([]);
  }
});
