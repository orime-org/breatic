// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup canvas on the node (inner#1303 §6.2): shown while markup is open,
 * its channel registered for the handlers outside it, and Escape taken in the
 * capture phase while a text is being edited or an object is selected. The
 * canvas's own write-back rules are pinned in `mark-canvas.test.ts`.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
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
 * @param init - More of the key event.
 * @param on - Where the key is pressed.
 * @returns The event, to read whether it was taken.
 */
function pressEscape(init: KeyboardEventInit = {}, on: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  act(() => {
    on.dispatchEvent(event);
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

  // §6.2: Fabric draws at the node's screen pixels, the element at its layout size.
  it('builds the canvas at the page’s zoom', async () => {
    render(cropCanvas([NODE], null, 0.5));
    act(() => store().openMiniTool('n1', 'image.mark', { sourceContent: NODE.src, params: {} }));
    await waitFor(() => expect(store().markChannel).not.toBeNull());
    const drawn = screen.getByTestId('mini-tool-mark-layer').querySelector('canvas')!;
    expect(drawn.width).toBe(200);
    expect(drawn.style.width).toBe('400px');
  });

  // A Space left for another keeps its page under a hidden Activity; Fabric's
  // teardown puts its canvas element back where it built (CanvasDOMManager).
  it('holds one canvas after its Space is hidden and shown again', async () => {
    const page = cropCanvas([NODE], null);
    const { rerender } = render(<React.Activity mode='visible'>{page}</React.Activity>);
    act(() => store().openMiniTool('n1', 'image.mark', { sourceContent: NODE.src, params: {} }));
    await waitFor(() => expect(store().markChannel).not.toBeNull());
    rerender(<React.Activity mode='hidden'>{page}</React.Activity>);
    await waitFor(() => expect(store().markChannel).toBeNull());
    rerender(<React.Activity mode='visible'>{page}</React.Activity>);
    await waitFor(() => expect(store().markChannel).not.toBeNull());
    const layer = screen.getByTestId('mini-tool-mark-layer');
    expect(layer.children).toHaveLength(1);
    expect(layer.querySelectorAll('canvas')).toHaveLength(2);
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
    // The session freezes what it holds, so a stand-in channel is registered.
    const exit = vi.fn();
    act(() => {
      store().registerMarkChannel({ exitEditing: exit, discardSelection: vi.fn() });
      store().setMarkEditingText('hi');
    });
    const event = pressEscape();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(store().miniTool).not.toBeNull();
  });

  // Focus can leave Fabric's input while the edit stays open; a menu or list
  // opened elsewhere then takes its own Escape.
  it('leaves Escape to a menu over the canvas while a text is being edited', async () => {
    await mount();
    const exit = vi.fn();
    act(() => {
      store().registerMarkChannel({ exitEditing: exit, discardSelection: vi.fn() });
      store().setMarkEditingText('hi');
    });
    const menu = document.createElement('div');
    document.body.append(menu);
    expect(pressEscape({}, menu).defaultPrevented).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    menu.remove();
  });

  it('takes Escape pressed in Fabric\'s own text input', async () => {
    await mount();
    const exit = vi.fn();
    act(() => {
      store().registerMarkChannel({ exitEditing: exit, discardSelection: vi.fn() });
      store().setMarkEditingText('hi');
    });
    const input = document.createElement('textarea');
    input.dataset.fabric = 'textarea';
    document.body.append(input);
    expect(pressEscape({}, input).defaultPrevented).toBe(true);
    expect(exit).toHaveBeenCalledOnce();
    input.remove();
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

  // An Escape that cancels an input method's candidates belongs to it.
  it('leaves the text edit alone on an Escape that ends a composition', async () => {
    await mount();
    const exit = vi.fn();
    act(() => {
      store().registerMarkChannel({ exitEditing: exit, discardSelection: vi.fn() });
      store().setMarkEditingText('bei');
    });
    expect(pressEscape({ isComposing: true }).defaultPrevented).toBe(false);
    expect(pressEscape({ keyCode: 229 }).defaultPrevented).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves a held Escape alone', async () => {
    await mount();
    act(() => {
      store().commitMark([RECT]);
      store().selectMark('r');
    });
    expect(pressEscape({ repeat: true }).defaultPrevented).toBe(false);
    expect(store().miniTool?.mark?.selectedId).toBe('r');
  });

  // A menu or dialog over the canvas takes its own Escape first.
  it('leaves Escape to a menu over the canvas while an object is selected', async () => {
    await mount();
    act(() => {
      store().commitMark([RECT]);
      store().selectMark('r');
    });
    const menu = document.createElement('div');
    document.body.append(menu);
    expect(pressEscape({}, menu).defaultPrevented).toBe(false);
    expect(store().miniTool?.mark?.selectedId).toBe('r');
    menu.remove();
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
