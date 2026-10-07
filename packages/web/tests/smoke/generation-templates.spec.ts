// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The template button in a generate panel's corner (inner#977): the image
 * panel lists its templates, picking one sets the panel up and reminds the
 * reader to edit the marked parts, and a panel with no templates says so.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

test.use({ viewport: { width: 1440, height: 1080 } });

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * Write one empty node into the open Space's document and open its panel.
 * @param kind - The node type to write.
 * @returns The node's id.
 */
async function openPanelOnNewNode(kind: 'image' | 'video'): Promise<string> {
  const nodeId = crypto.randomUUID();
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, id, type, at]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id,
        type,
        position: { x: 0, y: 0 },
        data: { name: `${type}-template`, createdAt: Date.now(), createdBy: 'template-e2e', locked: false, state: 'idle', attachments: [] },
      });
    },
    [projectId, spaceId, nodeId, kind, canvasAt] as [string, string, string, string, string],
  );
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-generate').click();
  return nodeId;
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ storageState: STATE_FILE.A });
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  spaceId = await createSpace(page, 'canvas', `template-e2e-${Date.now()}`);
});

test.afterEach(async () => {
  await deleteSpace(page, spaceId);
  await page.close();
});

test('picking a template sets the image panel up and reminds the reader', async () => {
  await openPanelOnNewNode('image');
  const trigger = page.getByTestId('generate-template-trigger');
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  // Right before the close button, in the panel's corner.
  expect(await trigger.evaluate((el) => el.nextElementSibling?.getAttribute('data-testid'))).toBe('generate-exit');

  await trigger.click();
  await expect(page.getByTestId('generate-template-costume-sheet')).toBeVisible();
  await page.getByTestId('generate-template-storyboard-grid-25').click();

  await expect(page.getByTestId('generate-mode-trigger')).toHaveText('Image to Image');
  await expect(page.getByTestId('generate-model-trigger')).toContainText('Nano Banana Pro');
  const prompt = page.getByTestId('generate-prompt-editor');
  await expect(prompt).toContainText('[📎 Use @ to pick character or scene reference]');
  await expect(prompt).toContainText('{✏️ the story}');
  // Nothing is @'d for the reader.
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(0);
  await expect(page.getByText('Replace the text in square brackets and braces.', { exact: false })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('image-template-applied.png') });
});

test('a panel with no templates says so', async () => {
  await openPanelOnNewNode('video');
  await page.getByTestId('generate-template-trigger').click();
  await expect(page.getByTestId('generate-template-empty')).toHaveText('No templates');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('generate-template-empty')).toBeHidden();
});

test('a note at the top of a prompt shows in orange, and generation does not get it', async () => {
  const nodeId = await openPanelOnNewNode('image');
  await expect(page.getByTestId('generate-prompt-editor')).toBeVisible({ timeout: 15_000 });
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  // Stateless, so a fresh copy served from source writes the same blocks; its
  // yjs resolves to the dependency the page already loaded.
  const promptAt = '/spaces/canvas/generate/proposal-prompt.ts';
  await page.evaluate(
    async ([pid, sid, id, at, writer]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; data: { mode?: string } }[] };
        getPromptFragment: (p: string, s: string, n: string, m: string) => unknown;
      };
      const { writeProposalPrompt } = (await import(/* @vite-ignore */ writer)) as {
        writeProposalPrompt: (f: unknown, segments: unknown[]) => void;
      };
      const mode = canvas.readCanvasGraph(pid, sid).nodes.find((n) => n.id === id)?.data.mode ?? 't2i';
      writeProposalPrompt(canvas.getPromptFragment(pid, sid, id, mode), [
        { slot: { kind: 'note', label: 'Pick a picture in the panel' } },
        { text: 'a red boat on a still pond' },
      ]);
    },
    [projectId, spaceId, nodeId, canvasAt, promptAt] as [string, string, string, string, string],
  );

  const note = page.getByTestId('generate-prompt-editor').locator('[data-prompt-note]');
  await expect(note).toHaveText('Pick a picture in the panel');
  const [color, warning] = await note.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-status-warning-foreground)';
    document.body.append(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(el).color, want];
  });
  expect(color).toBe(warning);

  let sent: { params?: { prompt?: string } } | null = null;
  await page.route('**/canvas/tasks', async (route) => {
    sent = route.request().postDataJSON() as { params?: { prompt?: string } };
    await route.abort();
  });
  await page.getByTestId('generate-execute').click();
  await expect.poll(() => sent, { timeout: 15_000 }).not.toBeNull();
  const prompt = (sent as { params?: { prompt?: string } } | null)?.params?.prompt ?? '';
  expect(prompt).toContain('a red boat on a still pond');
  expect(prompt).not.toContain('Pick a picture');
  await page.screenshot({ path: test.info().outputPath('prompt-note.png') });
});
