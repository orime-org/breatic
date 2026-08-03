// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The text node's body, bound to a shared fragment (#1774).
 *
 * What changed: the text no longer arrives in `data`. It is a shared fragment
 * on the node — subscribed to for display, bound directly by the editor while
 * editing — so two people typing merge character by character instead of
 * overwriting each other on blur.
 *
 * That moves the read-only gate. It used to sit in the container's
 * `setNodeContent` wrapper, on the one path a committed string travelled. There
 * is no committed string any more, so the gate travels to where the binding
 * happens, and this file is where it is proved: a viewer cannot open the
 * editor, and cannot repair a missing body either.
 *
 * Keyboard entry is NOT tested here. The listener that opens the editor on
 * Enter lives on ReactFlow's node wrapper — nothing this file renders — for
 * reasons spelled out at the listener itself. Dispatching a keydown at the
 * body would pass against a handler that can never fire in a browser, so the
 * keyboard cases live in `flow-node-types.test`, which renders a real wrapper.
 *
 * The visual invariants below are inherited from the contenteditable era and
 * assert against the editor's real element rather than a class substring —
 * a class written as `[&_.ProseMirror]:min-h-48` would satisfy the old
 * assertions while landing nowhere near the editor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, getTextBody } from '@web/data/yjs/canvas-space';
import { writePlainTextIntoBody, bodyToPlainText } from '@web/data/yjs/text-body';
import {
  CanvasContext,
  type CanvasContextValue,
} from '@web/spaces/canvas/canvas-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { TextNode } from '@web/spaces/canvas/nodes/TextNode';
import type { TextNodeView } from '@web/spaces/canvas/types/node-view';

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));
import { toast } from 'sonner';

const PID = 'p1';
const SID = 's1';
const NODE = 'n1';

/**
 * Create the fixture text node, optionally with body text.
 * @param text - Initial body text.
 */
function seedNode(text = ''): void {
  const fields: CanvasNodeFields = {
    id: NODE,
    type: 'text',
    position: { x: 0, y: 0 },
    data: {
      name: 'N',
      createdAt: 1,
      createdBy: 'u',
      locked: false,
      operationLocks: [],
      state: 'idle',
      attachments: [],
    },
  };
  addNode(PID, SID, fields);
  if (text) writePlainTextIntoBody(getTextBody(PID, SID, NODE) as Y.XmlFragment, text);
}

/**
 * The node's live body fragment.
 * @returns The fragment.
 */
function body(): Y.XmlFragment {
  return getTextBody(PID, SID, NODE) as Y.XmlFragment;
}

/**
 * Put the fixture node in the state an older node is in: no body at all.
 */
function stripBody(): void {
  const data = getDoc(docName.canvasSpace(PID, SID))
    .getMap<Y.Map<unknown>>('nodesMap')
    .get(NODE)
    ?.get('data') as Y.Map<unknown>;
  data.delete('body');
}

/**
 * Build the canvas context value for a render.
 * @param over - Field overrides.
 * @returns A complete context value.
 */
function canvasValue(over: Partial<CanvasContextValue> = {}): CanvasContextValue {
  return {
    projectId: PID,
    spaceId: SID,
    readOnly: false,
    caretProvider: null,
    caretUser: null,
    ...over,
  };
}

/**
 * The node element under a canvas context.
 * @param opts - View overrides, context overrides, and the locked flag.
 * @returns The element tree to render.
 */
function tree(
  opts: {
    view?: Partial<TextNodeView>;
    canvas?: Partial<CanvasContextValue>;
    locked?: boolean;
  } = {},
): React.JSX.Element {
  const view = { kind: 'text', status: 'idle', ...opts.view } as TextNodeView;
  return (
    <CanvasContext.Provider value={canvasValue(opts.canvas)}>
      <NodeIdContext.Provider value={NODE}>
        <TextNode data={view} locked={opts.locked} />
      </NodeIdContext.Provider>
    </CanvasContext.Provider>
  );
}

/**
 * Render the node under a canvas context.
 * @param opts - Same options as {@link tree}.
 * @returns The render result.
 */
function renderNode(
  opts: Parameters<typeof tree>[0] = {},
): ReturnType<typeof render> {
  return render(tree(opts));
}

/**
 * The mounted editor's editable element, if the editor is open.
 * @returns The `.ProseMirror` element or null.
 */
function editor(): HTMLElement | null {
  return document.querySelector('.ProseMirror');
}

/**
 * Enter edit mode by double-clicking the display body.
 */
function enterByDoubleClick(): void {
  fireEvent.doubleClick(screen.getByTestId('text-node-body'));
}

describe('TextNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  describe('display', () => {
    it('shows the shared body, which no longer travels in the node view', () => {
      seedNode('written by somebody');
      renderNode();
      expect(screen.getByTestId('text-node-body')).toHaveTextContent(
        'written by somebody',
      );
    });

    it('updates when a collaborator types', () => {
      seedNode('first');
      renderNode();
      act(() => {
        writePlainTextIntoBody(body(), 'second');
      });
      expect(screen.getByTestId('text-node-body')).toHaveTextContent('second');
    });

    it('shows the placeholder for an empty body', () => {
      seedNode();
      renderNode();
      expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
    });

    it('shows the placeholder, not an error, for a node that has no body', () => {
      seedNode();
      stripBody();
      renderNode();
      expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
    });

    it('surfaces the loading skeleton while a task is writing', () => {
      seedNode('x');
      renderNode({ view: { status: 'handling' } });
      expect(screen.getByTestId('node-content-handling')).toBeInTheDocument();
    });

    it('surfaces the error message', () => {
      seedNode('x');
      renderNode({ view: { status: 'error', errorMessage: 'Boom' } });
      expect(screen.getByTestId('node-content-error')).toHaveTextContent('Boom');
    });

    it('advertises no editable affordances, so Delete still removes the node', () => {
      // ReactFlow's isInputDOMNode flags ANY element carrying a
      // `contenteditable` attribute as an input — the value is never read, so
      // even `contentEditable={false}` (which React renders as the literal
      // attribute) swallows Delete. A focusable body also steals click focus
      // from node selection. Both break deleting a filled node (#260).
      seedNode('x');
      renderNode();
      const el = screen.getByTestId('text-node-body');
      expect(el.hasAttribute('contenteditable')).toBe(false);
      expect(el.hasAttribute('tabindex')).toBe(false);
      expect(el.getAttribute('role')).not.toBe('textbox');
    });

    it('selecting the node does not open the editor', () => {
      seedNode('x');
      render(
        <CanvasContext.Provider value={canvasValue()}>
          <NodeIdContext.Provider value={NODE}>
            <TextNode data={{ kind: 'text', status: 'idle' } as TextNodeView} selected />
          </NodeIdContext.Provider>
        </CanvasContext.Provider>,
      );
      expect(editor()).toBeNull();
    });

    it('clips instead of scrolling, and leaves the wheel to the canvas', () => {
      // The display body caps at 576px (max-h-144 = width 288 x 2) and CLIPS
      // (#1470 / #1479): no scrollbar you cannot use, a bottom fade hints
      // there is more, and no `nowheel` so the wheel zooms the canvas like it
      // does over every other node.
      seedNode('long text');
      renderNode();
      const el = screen.getByTestId('text-node-body');
      expect(el.className).toContain('max-h-144');
      expect(el.className).toContain('overflow-hidden');
      expect(el.className).not.toContain('overflow-y-auto');
      expect(el.className).toContain('break-words');
      expect(el.className).toContain('text-justify');
      expect(el.className).toContain('min-h-48');
      expect(el.className).not.toContain('nowheel');
      expect(el.closest('.nowheel')).toBeNull();
    });
  });

  describe('entering the editor', () => {
    it('mounts an editor holding the body on double-click', () => {
      seedNode('already here');
      renderNode();
      enterByDoubleClick();
      expect(editor()).not.toBeNull();
      expect(editor()?.textContent).toContain('already here');
    });

    it('opens from the placeholder, so a brand new node can be written in', () => {
      seedNode();
      renderNode();
      fireEvent.doubleClick(screen.getByTestId('node-placeholder'));
      expect(editor()).not.toBeNull();
    });


    it('repairs a missing body before binding, never binding to nothing', () => {
      // The shared layer requires a fragment and refuses to bind to nothing,
      // so a node that has none has to be repaired first, at the moment
      // somebody actually wants to write.
      seedNode();
      stripBody();
      renderNode();
      fireEvent.doubleClick(screen.getByTestId('node-placeholder'));

      expect(getTextBody(PID, SID, NODE)).not.toBeNull();
      expect(editor()).not.toBeNull();
    });

    it('scrolls the text, not the canvas, while editing', () => {
      seedNode('long text');
      renderNode();
      enterByDoubleClick();
      const el = editor() as HTMLElement;
      expect(el.closest('.nowheel')).not.toBeNull();
      expect(el.closest('.nodrag')).not.toBeNull();
      const viewport = el.closest('[data-radix-scroll-area-viewport]');
      expect(viewport).not.toBeNull();
      expect((viewport as HTMLElement).className).toContain('max-h-144');
      // Real scroll capability, not just classes: Radix sets overflowY only
      // while a vertical scrollbar is mounted, and text past the cap would
      // otherwise be unreachable with the class assertions still green.
      expect((viewport as HTMLElement).style.overflowY).toBe('scroll');
    });

    it('lands its own classes on the editable element itself', () => {
      // Every one of these has to be on the element the caret lives in. On a
      // wrapper, the min height becomes dead space that does not take a click,
      // the outline reset misses the focused element, and the text cursor
      // falls back to the canvas grab hand (user bug 2026-07-04).
      seedNode('x');
      renderNode();
      enterByDoubleClick();
      const el = editor() as HTMLElement;
      for (const cls of [
        'min-h-48',
        'p-3',
        'whitespace-pre-wrap',
        'break-words',
        'text-justify',
        'text-sm',
        'outline-none',
        'cursor-text',
      ]) {
        expect(el.className).toContain(cls);
      }
    });
  });

  describe('leaving the editor', () => {
    it('closes on Escape', () => {
      seedNode('x');
      renderNode();
      enterByDoubleClick();
      expect(editor()).not.toBeNull();

      fireEvent.keyDown(editor() as HTMLElement, { key: 'Escape' });
      expect(editor()).toBeNull();
    });

    it('closes when the node is locked mid-edit, and keeps what was written', () => {
      seedNode('typed so far');
      const { rerender } = renderNode();
      enterByDoubleClick();
      expect(editor()).not.toBeNull();

      rerender(tree({ locked: true }));

      expect(editor()).toBeNull();
      // Live sync means the text is already in the document. There is nothing
      // to discard, and discarding would delete a collaborator's words too.
      expect(bodyToPlainText(body())).toBe('typed so far');
    });

    it('closes when a task starts writing the node mid-edit', () => {
      seedNode('typed so far');
      const { rerender } = renderNode();
      enterByDoubleClick();
      expect(editor()).not.toBeNull();

      rerender(tree({ view: { status: 'handling' } }));
      expect(editor()).toBeNull();
    });
  });

  describe('gates', () => {
    it('refuses to open for a read-only viewer', () => {
      seedNode('x');
      renderNode({ canvas: { readOnly: true } });
      enterByDoubleClick();
      expect(editor()).toBeNull();
    });

    it('does not repair a missing body for a read-only viewer', () => {
      // Repair is a write. A viewer's would be dropped by the server without
      // an error, leaving them one paragraph ahead of everybody else.
      seedNode();
      stripBody();
      renderNode({ canvas: { readOnly: true } });
      fireEvent.doubleClick(screen.getByTestId('node-placeholder'));

      expect(getTextBody(PID, SID, NODE)).toBeNull();
      expect(editor()).toBeNull();
    });

    it('refuses to open a locked node and says why', () => {
      seedNode('x');
      renderNode({ locked: true });
      enterByDoubleClick();
      expect(editor()).toBeNull();
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });

    it('refuses to open a locked empty node from its placeholder and says why', () => {
      seedNode();
      renderNode({ locked: true });
      fireEvent.doubleClick(screen.getByTestId('node-placeholder'));
      expect(editor()).toBeNull();
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });

  });
});
