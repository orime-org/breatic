// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Seeding a node, opening a mini-tool on it and zooming the canvas, for the
 * mini-tool smoke cases.
 */

import { expect, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from './live-module';
import { visibleSpace } from './space';

/** Where a seeded node goes. */
export interface SeedTarget {
  projectId: string;
  spaceId: string;
}

/**
 * Seed a node straight into the live canvas document.
 * @param page - The page.
 * @param where - The project and Space.
 * @param id - Node id.
 * @param type - Node modality.
 * @param x - Flow x.
 * @param data - Extra data fields.
 * @returns Nothing; resolves once the document holds the node.
 */
export async function seedNode(
  page: Page,
  where: SeedTarget,
  id: string,
  type: string,
  x: number,
  data: Record<string, unknown> = {},
): Promise<void> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, nodeId, nodeType, at, raw, url]: [string, string, string, string, number, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id: nodeId,
        type: nodeType,
        position: { x: at, y: 0 },
        data: {
          name: 'SEED',
          createdAt: Date.now(),
          createdBy: 'mini-tools-e2e',
          locked: false,
          attachments: [],
          ...(JSON.parse(raw) as Record<string, unknown>),
        },
      });
    },
    [where.projectId, where.spaceId, id, type, x, JSON.stringify(data), canvasAt] as [
      string,
      string,
      string,
      string,
      number,
      string,
      string,
    ],
  );
  await expect(visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible({ timeout: 15_000 });
}

/**
 * Open a tool on a node from its menu.
 * @param page - The page.
 * @param nodeId - The node.
 * @param toolId - The tool.
 */
export async function openTool(page: Page, nodeId: string, toolId: string): Promise<void> {
  await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).click({ button: 'right' });
  await page.getByTestId('node-menu-tools').hover();
  await page.getByTestId(`node-menu-tool-${toolId}`).click();
}

/**
 * Zoom the canvas with the wheel over its middle.
 * @param page - The page.
 * @param deltaY - Wheel delta; negative zooms in.
 */
export async function zoomBy(page: Page, deltaY: number): Promise<void> {
  const pane = visibleSpace(page).locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('no pane');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up('Control');
}
