// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The opening the audio Generate panel's cases start from, and the two moves
 * every one of them makes.
 *
 * The cases live in two files — the ones that walk a generation attempt in
 * `tests/smoke/`, the ones that measure the panel in `tests/visual/` — and
 * both need the same Space with the same kind of node in it. This module is
 * imported by each, which registers its hooks once per file: a module a spec
 * imports is evaluated in that spec's own scope, so the state below holds only
 * that file's Space and the two files cannot reach each other's (measured,
 * playwright 1.62.1, 2026-09-19).
 *
 * Each case gets its own Space rather than sharing one across the file. A
 * shared opening makes the first red take every case after it down with it,
 * which reports cases as never run instead of saying what broke.
 */
import { expect, test, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from './live-module';
import { openSmokeProject } from './project';
import { createSpace, deleteSpace } from './space';

/** What the current case is working in. */
interface Stage {
  page: Page;
  projectId: string;
  spaceId: string;
}

/** The current case's opening, replaced before each of them. */
let stage: Stage | null = null;

/**
 * The page, Project and Space this case was given.
 * @returns The current case's opening.
 * @throws {Error} When called outside a case, where there is none.
 */
function current(): Stage {
  if (stage === null) {
    throw new Error('no opening: audio-panel helpers only work inside a case');
  }
  return stage;
}

/**
 * Where the next seeded node goes.
 *
 * A node is 288 wide, so dropping them all at one point stacks them and a
 * right-click meant for the one underneath lands on whatever was seeded last.
 * The canvas also mounts only what the viewport intersects
 * (`onlyRenderVisibleElements`, `CanvasSpace.tsx:4126`), so a row that kept
 * growing across cases would walk off the edge and the node would not be in
 * the DOM at all. Each case has its own Space, so each starts its own row at
 * the origin.
 */
const SEED_STEP = 300;
let seededSoFar = 0;

test.beforeEach(async ({ page }) => {
  await openSmokeProject(page);
  // The URL segment is the project's SLUG, which ends in its id. Splitting on
  // `/project/` yields the slug, and a Yjs document named after that is a
  // second, empty one — writes into it land nowhere the canvas reads.
  const projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  const spaceId = await createSpace(page, 'canvas', `audio-e2e-${Date.now()}`);
  seededSoFar = 0;
  stage = { page, projectId, spaceId };
});

test.afterEach(async () => {
  if (stage === null) return;
  await deleteSpace(stage.page, stage.spaceId);
  stage = null;
});

/**
 * Write one node into the open Space's document.
 *
 * Seeded rather than generated: what these cases are here to exercise is the
 * panel, and a node arrives on the canvas by upload or by an earlier
 * generation — neither of which they are about.
 *
 * The id is a UUID because the task endpoint's schema requires one for both
 * `target_node_id` and every key of `node_gens`; a readable id gets the submit
 * rejected at the boundary, which no case here is about.
 * @param nodeId - The id to give the node, a UUID.
 * @param kind - The node type to write.
 * @param content - The asset URL the node holds, if any.
 * @param atX - Where to put it, overriding the running row.
 * @param atY - How far up to put it. The panel hangs BELOW its node
 *   (`generate-panel-frame.tsx:196`, `Position.Bottom`, no flip), so a taller
 *   panel runs further past the window bottom — the music modes carry a second
 *   editor and reach 396px against this suite's 720px window. Raising the node
 *   is what a person does by panning.
 * @throws {Error} When the node never reaches the document.
 */
export async function seedNode(
  nodeId: string,
  kind: 'audio' | 'video',
  content?: string,
  atX?: number,
  atY = 0,
): Promise<void> {
  const { page, projectId, spaceId } = current();
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const x = atX ?? seededSoFar * SEED_STEP;
  seededSoFar += 1;
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  const seen = await page.evaluate(
    async ([pid, sid, id, type, asset, left, top, at]: [string, string, string, string, string, number, number, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string }[] };
      };
      canvas.addNode(pid, sid, {
        id,
        type,
        position: { x: left, y: top },
        data: {
          name: `${type}-e2e`,
          createdAt: Date.now(),
          createdBy: 'audio-e2e',
          locked: false,
          state: 'idle',
          attachments: [],
          ...(asset ? { content: asset, status: 'ready' } : {}),
        },
      });
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id);
    },
    [projectId, spaceId, nodeId, kind, content ?? '', x, atY, canvasAt] as [
      string,
      string,
      string,
      string,
      string,
      number,
      number,
      string,
    ],
  );
  if (!seen.includes(nodeId)) {
    throw new Error(`${nodeId} never reached the document; saw [${seen.join(', ')}]`);
  }
}

/**
 * Pan the canvas, the way a person does with two fingers.
 *
 * A Space a case made for itself frames what is in it, so one seeded node ends
 * up in the middle of the canvas. The panel hangs BELOW its node
 * (`generate-panel-frame.tsx:196`, `Position.Bottom`, no flip) and the music
 * modes carry a second editor, so a panel opened there runs past the window
 * bottom and its lower half cannot be clicked. Panning first is what a person
 * does; `panOnScroll` is on (`CanvasSpace.tsx:4217`), so a plain wheel pans.
 * @param by - How far to scroll down, which moves the content up.
 * @throws {Error} When the canvas is not on the page.
 */
export async function panCanvasDown(by: number): Promise<void> {
  const { page } = current();
  const pane = page.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane is not on the page');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, by);
}

/**
 * Open the Generate panel on a node the way a person does: right-click, then
 * the menu item.
 * @param nodeId - The node to open it on.
 * @param settled - A testid the open panel is known to render, waited on.
 */
export async function openGenerate(nodeId: string, settled = 'generate-audio-execute'): Promise<void> {
  const { page } = current();
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-generate').click();
  await expect(page.getByTestId(settled)).toBeVisible({ timeout: 15_000 });
}
