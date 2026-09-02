// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The audio Generate panel, end to end (#1960 PR1).
 *
 * What no jsdom test reaches: the voice list comes from an endpoint that asks
 * a vendor, the panel opens off a real context menu on a real canvas node, and
 * the submit gate is judged against a prompt the collaborative editor
 * serialized rather than a string a test handed it.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 *
 * Skips itself when the credentials are absent, so an unconfigured checkout
 * still passes the suite.
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.describe.configure({ mode: 'serial' });

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * Sign in and leave the page wherever the app lands.
 * @param p - A fresh page.
 */
async function signIn(p: Page): Promise<void> {
  await p.goto('/login');
  await p.locator('#login-email').fill(email as string);
  await p.locator('#login-password').fill(password as string);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

/**
 * Write one audio node into the open Space's document.
 *
 * Seeded rather than generated: what this file is here to exercise is the
 * panel, and an audio node arrives on the canvas by upload or by an earlier
 * generation — neither of which this case is about.
 * @param p - A page with the Space open.
 * @param nodeId - The id to give the node.
 */
async function seedAudioNode(p: Page, nodeId: string): Promise<void> {
  await expect(p.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const seen = await p.evaluate(
    async ([pid, sid, id]: [string, string, string]) => {
      // Vite serves each module under a versioned URL; importing the bare path
      // would evaluate a SECOND copy whose caches are empty.
      const live = (re: RegExp): string => {
        const found = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => re.test(n));
        if (found === undefined) throw new Error(`no module matches ${re.source}`);
        return found;
      };
      const canvas = (await import(
        /* @vite-ignore */ live(/data\/yjs\/canvas-space\.ts/)
      )) as {
        addNode: (p: string, s: string, n: unknown) => void;
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string }[] };
      };
      canvas.addNode(pid, sid, {
        id,
        type: 'audio',
        position: { x: 0, y: 0 },
        data: {
          name: 'audio-e2e',
          createdAt: Date.now(),
          createdBy: 'audio-e2e',
          locked: false,
          state: 'idle',
          attachments: [],
        },
      });
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id);
    },
    [projectId, spaceId, nodeId] as [string, string, string],
  );
  if (!seen.includes(nodeId)) {
    throw new Error(`${nodeId} never reached the document; saw [${seen.join(', ')}]`);
  }
}

/**
 * Open the Generate panel on a node the way a person does: right-click, then
 * the menu item.
 * @param p - A page with the Space open.
 * @param nodeId - The node to open it on.
 */
async function openGenerate(p: Page, nodeId: string): Promise<void> {
  const node = p.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await p.getByTestId('node-menu-generate').click();
  await expect(p.getByTestId('generate-audio-execute')).toBeVisible({
    timeout: 15_000,
  });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signIn(page);
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 20_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\/[^/]+/, { timeout: 15_000 });
  // The URL segment is the project's SLUG, which ends in its id. Splitting on
  // `/project/` yields the slug, and a Yjs document named after that is a
  // second, empty one — writes into it land nowhere the canvas reads.
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  spaceId = await createSpace(page, 'canvas', `audio-e2e-${Date.now()}`);
});

test.afterAll(async () => {
  if (spaceId) await deleteSpace(page, spaceId);
  await page.close();
});

// One node, one panel, one continuous session — which is also how a person
// uses it: open it, look at it, adjust it, submit. Splitting these into a test
// each would reopen the panel three times and say nothing more.
test('the panel opens, offers what the model declares, and refuses a voiceless submit', async () => {
  test.setTimeout(90_000);
  const nodeId = `audio-${Date.now()}`;
  await seedAudioNode(page, nodeId);
  await openGenerate(page, nodeId);

  await expect(page.getByTestId('generate-audio-mode-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-model-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-voice-trigger')).toBeVisible();
  await expect(page.getByTestId('generate-audio-tool-reference')).toBeVisible();
  // The rate, not a total: both vendors bill by how much text is sent.
  await expect(page.getByTestId('generate-audio-rate')).toBeVisible();

  // ElevenLabs v3 documents stability as three named stops, so it renders as
  // options; similarity is a range, so it renders as a slider.
  await page.getByTestId('generate-audio-params-trigger').click();
  await expect(page.getByTestId('generate-audio-stability-option-0.5')).toBeVisible();
  await expect(page.getByRole('slider', { name: /similarity/i })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('Good evening.');
  await page.getByTestId('generate-audio-execute').click();

  // The refusal speaks: the catalog's default voice is not a value every
  // deployment accepts, so an untouched picker means no voice.
  await expect(page.locator('[data-sonner-toast]').first()).toBeVisible({
    timeout: 10_000,
  });
});
