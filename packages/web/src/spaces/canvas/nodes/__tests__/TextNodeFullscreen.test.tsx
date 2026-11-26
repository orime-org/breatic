// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Full screen for a text node (inner#2115): a canvas-level layer with an
 * editor of its own on the node's shared body, opened from a button over the
 * card's top-right corner.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';

import { _resetForTests } from '@web/data/yjs/manager';
import { addNode, getTextBody } from '@web/data/yjs/canvas-space';
import { writePlainTextIntoBody, bodyToPlainText } from '@breatic/shared/canvas/text-body';
import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { TextNode } from '@web/spaces/canvas/nodes/TextNode';
import { TextNodeFullscreen } from '@web/spaces/canvas/nodes/TextNodeFullscreen';
import type { TextNodeView } from '@web/data/yjs/node-view';
import { canvasSessions } from '@web/stores/canvas-session';

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

const PID = 'p1';
const SID = 's1';
const NODE = 'n1';

/**
 * Create the fixture text node with some body text.
 * @param text - Initial body text.
 */
function seedNode(text = 'Scene one. The dock at night.'): void {
  const fields: CanvasNodeFields = {
    id: NODE,
    type: 'text',
    position: { x: 0, y: 0 },
    data: { name: 'Script', createdAt: 1, createdBy: 'u', locked: false, attachments: [] },
  };
  addNode(PID, SID, fields);
  if (text) writePlainTextIntoBody(getTextBody(PID, SID, NODE) as Y.XmlFragment, text);
}

/**
 * Build the canvas context value for a render.
 * @param over - Field overrides.
 * @returns A complete context value.
 */
function canvasValue(over: Partial<CanvasContextValue> = {}): CanvasContextValue {
  return { projectId: PID, spaceId: SID, readOnly: false, myRole: 'editor', caretProvider: null, ...over };
}

/**
 * The canvas session of the fixture Space.
 * @returns Its state.
 */
function session(): ReturnType<ReturnType<typeof canvasSessions.of>['getState']> {
  return canvasSessions.of(SID).getState();
}

/**
 * Render the full-screen layer as the canvas renders it.
 * @param props - What the canvas knows about the node.
 * @param props.exists - Whether the node is still on the canvas.
 * @param props.locked - Whether the node is locked.
 * @param ctx - Canvas context overrides.
 * @returns The render result.
 */
function renderLayer(
  props: { exists?: boolean; locked?: boolean } = {},
  ctx: Partial<CanvasContextValue> = {},
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <CanvasContext.Provider value={canvasValue(ctx)}>
        <TextNodeFullscreen
          nodeId={NODE}
          name='Script'
          exists={props.exists ?? true}
          locked={props.locked ?? false}
        />
      </CanvasContext.Provider>
    </TooltipProvider>,
  );
}

/**
 * Render the text node itself.
 * @param over - Node props and context overrides.
 * @param over.locked - Whether the node is locked.
 * @param over.readOnly - Whether the viewer may only read.
 * @returns The render result.
 */
function renderNode(over: { locked?: boolean; readOnly?: boolean } = {}): ReturnType<typeof render> {
  const data = { name: 'Script', locked: over.locked ?? false } as unknown as TextNodeView;
  return render(
    <TooltipProvider>
      <CanvasContext.Provider value={canvasValue({ readOnly: over.readOnly ?? false })}>
        <NodeIdContext.Provider value={NODE}>
          <TextNode data={data} locked={over.locked ?? false} />
        </NodeIdContext.Provider>
      </CanvasContext.Provider>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  _resetForTests();
  canvasSessions.of(SID).setState({ fullscreenTextNode: null, editingTextNode: null, pickSession: null });
  seedNode();
});

describe('the full-screen button on a text node', () => {
  it('offers full-screen editing to a writer', () => {
    renderNode();
    expect(screen.getByTestId('text-fullscreen-button')).toHaveAttribute('aria-label', 'Edit full screen');
  });

  it('offers full-screen reading on a locked node and to a viewer', () => {
    const { unmount } = renderNode({ locked: true });
    expect(screen.getByTestId('text-fullscreen-button')).toHaveAttribute('aria-label', 'View full screen');
    unmount();
    renderNode({ readOnly: true });
    expect(screen.getByTestId('text-fullscreen-button')).toHaveAttribute('aria-label', 'View full screen');
  });

  it('is left out while the canvas is picking', () => {
    canvasSessions.of(SID).getState().startReferencePick('other-node');
    renderNode();
    expect(screen.queryByTestId('text-fullscreen-button')).toBeNull();
  });

  it('opens full screen on this node and ends writing in place', () => {
    canvasSessions.of(SID).getState().startTextEdit(NODE);
    renderNode();
    fireEvent.click(screen.getByTestId('text-fullscreen-button'));
    expect(session().fullscreenTextNode).toBe(NODE);
    expect(session().editingTextNode).toBeNull();
  });
});

describe('the full-screen layer of a text node', () => {
  it('shows the node name and an editor on the node body, writes going into the node', async () => {
    renderLayer();
    expect(screen.getByRole('dialog', { name: 'Script' })).toBeInTheDocument();
    const editor = await screen.findByTestId('text-fullscreen-editor');
    expect(editor.querySelector('[contenteditable="true"]')).not.toBeNull();
    expect(editor.textContent).toContain('Scene one. The dock at night.');
    act(() => {
      const body = getTextBody(PID, SID, NODE) as Y.XmlFragment;
      writePlainTextIntoBody(body, 'Scene one. The dock at night. Rain.');
    });
    await waitFor(() => expect(editor.textContent).toContain('Rain.'));
    expect(bodyToPlainText(getTextBody(PID, SID, NODE) as Y.XmlFragment)).toContain('Rain.');
  });

  it('is read-only on a locked node: the text, no editor', () => {
    renderLayer({ locked: true });
    expect(screen.getByTestId('text-fullscreen-readonly')).toHaveTextContent('Scene one. The dock at night.');
    expect(screen.queryByTestId('text-fullscreen-editor')).toBeNull();
  });

  it('is read-only for a viewer', () => {
    renderLayer({}, { readOnly: true });
    expect(screen.getByTestId('text-fullscreen-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('text-fullscreen-editor')).toBeNull();
  });

  it('turns read-only when the node is locked while it is open', async () => {
    const { rerender } = renderLayer();
    await screen.findByTestId('text-fullscreen-editor');
    rerender(
      <TooltipProvider>
        <CanvasContext.Provider value={canvasValue()}>
          <TextNodeFullscreen nodeId={NODE} name='Script' exists locked />
        </CanvasContext.Provider>
      </TooltipProvider>,
    );
    expect(screen.queryByTestId('text-fullscreen-editor')).toBeNull();
    expect(screen.getByTestId('text-fullscreen-readonly')).toBeInTheDocument();
  });

  it('closes when the node is deleted', () => {
    canvasSessions.of(SID).getState().openTextFullscreen(NODE);
    renderLayer({ exists: false });
    expect(session().fullscreenTextNode).toBeNull();
  });

  it('closes on Escape and on the exit button', () => {
    canvasSessions.of(SID).getState().openTextFullscreen(NODE);
    const { unmount } = renderLayer();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(session().fullscreenTextNode).toBeNull();
    unmount();
    canvasSessions.of(SID).getState().openTextFullscreen(NODE);
    renderLayer();
    fireEvent.click(screen.getByTestId('text-fullscreen-exit'));
    expect(session().fullscreenTextNode).toBeNull();
  });

  it('stays open on an Escape that belongs to the input method', () => {
    canvasSessions.of(SID).getState().openTextFullscreen(NODE);
    renderLayer();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', isComposing: true });
    expect(session().fullscreenTextNode).toBe(NODE);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 229 });
    expect(session().fullscreenTextNode).toBe(NODE);
  });
});
