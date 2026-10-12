// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup canvas on the node (inner#1303 §6.2): shown while markup is open,
 * its channel registered for the handlers outside it, and Escape taken in the
 * capture phase while a text is being edited or an object is selected. The
 * canvas's own write-back rules are pinned in `mark-canvas.test.ts`.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cropCanvas, installLayout } from '@web/spaces/canvas/crop/__tests__/crop-harness';
import { canvasSessions } from '@web/stores/canvas-session';
import { INK } from '@web/stores/drawing-draft';
import type { MarkObject } from '@web/stores/mark-draft';

const NODE = { id: 'n1', kind: 'img' as const, src: 'https://cdn/a.png' };
const RECT: MarkObject = { id: 'r', kind: 'rect', color: INK[0], size: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

/** The session store the canvas under test reads. */
const store = () => canvasSessions.of('').getState();

beforeEach(() => {
  installLayout();
  canvasSessions.clear();
});

/**
 * Render the node and open a tool on it, waiting for markup's canvas to load.
 * @param toolId - The tool.
 */
async function mount(toolId = 'image.mark'): Promise<void> {
  render(cropCanvas([NODE], null));
  act(() => store().openMiniTool('n1', toolId, { sourceContent: NODE.src, params: {} }));
  if (toolId === 'image.mark') await waitFor(() => expect(store().markChannel).not.toBeNull());
}

/**
 * Press Escape on the page the way a key from the focused node arrives.
 * @returns The event, to read whether it was taken.
 */
function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    document.body.dispatchEvent(event);
  });
  return event;
}

describe('NodeMarkLayer', () => {
  it('lays a canvas over the picture only while markup is open', async () => {
    await mount('image.crop');
    expect(screen.queryByTestId('mini-tool-mark-layer')).toBeNull();
    act(() => store().openMiniTool('n1', 'image.mark', { sourceContent: NODE.src, params: {} }));
    const layer = await screen.findByTestId('mini-tool-mark-layer');
    expect(layer.className).toMatch(/\bnodrag\b/);
    expect(layer.className).toMatch(/\bnopan\b/);
  });

  it('registers its channel while open and takes it back on close', async () => {
    await mount();
    act(() => store().closeActivePanel());
    expect(store().markChannel).toBeNull();
  });

  it('draws the objects the draft holds', async () => {
    await mount();
    act(() => store().commitMark([RECT]));
    await waitFor(() => expect(screen.getByTestId('mini-tool-mark-layer').dataset.objects).toBe('1'));
  });

  it('takes Escape to leave the text being edited and keeps the panel open', async () => {
    await mount();
    const exit = vi.spyOn(store().markChannel!, 'exitEditing');
    act(() => store().setMarkEditingText('hi'));
    const event = pressEscape();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(store().miniTool).not.toBeNull();
  });

  it('takes Escape to drop the selection and keeps the panel open', async () => {
    await mount();
    act(() => {
      store().commitMark([RECT]);
      store().selectMark('r');
    });
    const event = pressEscape();
    expect(event.defaultPrevented).toBe(true);
    expect(store().miniTool?.mark?.selectedId).toBeNull();
    expect(store().miniTool).not.toBeNull();
  });

  it('leaves Escape alone with nothing selected or edited, and while exporting', async () => {
    await mount();
    expect(pressEscape().defaultPrevented).toBe(false);
    act(() => {
      store().commitMark([RECT]);
      store().selectMark('r');
      store().setMiniToolExporting(true, store().panelSession);
    });
    expect(pressEscape().defaultPrevented).toBe(false);
  });
});
