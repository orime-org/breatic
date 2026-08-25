// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * keyboard cases live in `CanvasSpace.test`, the one place that mounts a real
 * ReactFlow and so has a real wrapper to press keys on.
 *
 * The visual invariants below are inherited from the contenteditable era and
 * assert against the editor's real element rather than a class substring —
 * a class written as `[&_.ProseMirror]:min-h-48` would satisfy the old
 * assertions while landing nowhere near the editor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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
import { TEXT_BODY_BOX } from '@web/spaces/canvas/nodes/TextNodeEditor';
import { useCanvasStore } from '@web/stores';
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

    it('shows the localized hint in an empty editor, not blankness', () => {
      // Acceptance item 8, pinned the way the document editor pins its own
      // (placeholder-follows-locale.test): the Placeholder extension writes
      // the hint into `data-placeholder` on the empty paragraph. Nothing else
      // asserted this end of the wire (round-5) — the extension could be
      // dropped, or the i18n key misspelled, with every test still green.
      seedNode();
      renderNode();
      fireEvent.doubleClick(screen.getByTestId('node-placeholder'));
      const hint =
        editor()
          ?.querySelector('[data-placeholder]')
          ?.getAttribute('data-placeholder') ?? '';
      // Empty catches a dropped extension. The dot catches ANY misspelled key:
      // a lookup miss returns the key itself, and every key is dotted while no
      // hint in any locale is. Naming the leaf instead (the first cut) only
      // caught misspellings that kept it — a truncated key sailed through
      // while the raw key showed up in the editor (round-6).
      expect(hint).not.toBe('');
      expect(hint).not.toContain('.');
    });


    it('refuses to open while a reference pick is running', () => {
      // A pick owns node interaction (user 2026-07-12 P2b). That rule used to
      // live on the wrapper's double-click capture — a guard on one EVENT —
      // so the keyboard doors this feature added walked straight past it and
      // opened the editor mid-pick, repairing a bodyless node on the way in,
      // which is a write into the shared document (round-7, probed in a real
      // ReactFlow mount: double-click blocked, Enter not). The guard now sits
      // on the action, so every door is covered.
      seedNode();
      renderNode();
      act(() => {
        useCanvasStore.getState().startStylePick('other-node');
      });
      fireEvent.click(screen.getByTestId('node-placeholder'), { detail: 0 });
      expect(editor()).toBeNull();
      // And nothing was written: a bodyless node stays bodyless.
      act(() => {
        useCanvasStore.setState({ pickSession: null });
      });
      fireEvent.click(screen.getByTestId('node-placeholder'), { detail: 0 });
      expect(editor()).not.toBeNull();
    });

    it('opens from the placeholder by keyboard, not only by double-click', () => {
      // Clicking an empty node lands focus on the placeholder button, not on
      // the node wrapper — so the wrapper's Enter listener never sees the
      // press, and without a keyboard path here the commonest sequence on a
      // brand new node (click it, press Enter, write) does nothing at all.
      // A keyboard activation reaches the button as a click with no pointer
      // behind it, which is what `detail: 0` means.
      seedNode();
      renderNode();
      fireEvent.click(screen.getByTestId('node-placeholder'), { detail: 0 });
      expect(editor()).not.toBeNull();
    });

    it('does not open on a plain click of the placeholder — that selects', () => {
      seedNode();
      renderNode();
      fireEvent.click(screen.getByTestId('node-placeholder'), { detail: 1 });
      expect(editor()).toBeNull();
    });

    it('puts the caret in the editor, so the first keystroke lands in it', async () => {
      // Without this the editor mounts unfocused: the caret stays wherever it
      // was, typing goes nowhere, and Backspace reaches the canvas and deletes
      // the node instead of a character.
      seedNode('already here');
      renderNode();
      enterByDoubleClick();
      // Asynchronous by design: the editor is built in an effect and takes
      // focus from a timeout of its own, so asserting synchronously would be
      // asking before it ever had the chance.
      await waitFor(() => {
        expect(document.activeElement).toBe(editor());
      });
    });

    it('announces itself as a multi-line text box, as the element it replaced did', () => {
      // A `contenteditable` div has no implicit role, so without these a
      // screen reader offers a group of text where a person is meant to write.
      seedNode('x');
      renderNode();
      enterByDoubleClick();
      expect(editor()?.getAttribute('role')).toBe('textbox');
      expect(editor()?.getAttribute('aria-multiline')).toBe('true');
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
        'break-words',
        'text-justify',
        'text-sm',
        'outline-none',
        'cursor-text',
      ]) {
        expect(el.className).toContain(cls);
      }
      // And no whitespace class: TipTap's own `.ProseMirror` rule sets
      // `white-space: break-spaces` unlayered, so a Tailwind one here can
      // never apply — the round-4 review found an inert `pre-wrap` reading as
      // a contradiction with the display state's declared value.
      expect(el.className).not.toMatch(/whitespace-/);
    });

    // Wrapping parity with the display state (acceptance item 10). The editor
    // computes `break-spaces` from TipTap's own stylesheet; the display body
    // has no such patron and must DECLARE the same value itself — this line is
    // the one that keeps identical words wrapping identically across the two
    // states, and it was the one line nothing asserted.
    it('display body declares the whitespace value the editor computes', () => {
      seedNode('x');
      renderNode();
      expect(
        screen.getByTestId('text-node-body').className,
      ).toContain('whitespace-break-spaces');
    });

    // The rest of item 10 rests on the two states measuring the same, and the
    // metrics used to be hand-copied between two files: changing the padding
    // on one typechecked, passed the suite, and broke the promise silently
    // (round-6). They now come from one constant, and this holds BOTH states
    // to it — so the day somebody edits the constant, both move together, and
    // the day somebody re-inlines a literal, this goes red.
    it('both states carry the shared box metrics, from one source', () => {
      seedNode('x');
      renderNode();
      const display = screen.getByTestId('text-node-body');
      for (const cls of TEXT_BODY_BOX.split(' ')) {
        expect(display.className).toContain(cls);
      }
      enterByDoubleClick();
      const editing = editor() as HTMLElement;
      for (const cls of TEXT_BODY_BOX.split(' ')) {
        expect(editing.className).toContain(cls);
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

    it('closes when focus goes somewhere else on the page', () => {
      // Clicking away is how most people leave an inline editor, and an editor
      // that never closes leaves a contenteditable on the node — which is what
      // makes ReactFlow swallow Delete, so the node cannot be removed either.
      seedNode('x');
      renderNode();
      enterByDoubleClick();
      expect(editor()).not.toBeNull();

      const elsewhere = document.createElement('button');
      document.body.appendChild(elsewhere);
      fireEvent.blur(editor() as HTMLElement, { relatedTarget: elsewhere });

      expect(editor()).toBeNull();
      elsewhere.remove();
    });

    it('stays open when focus moves inside the editor itself', () => {
      seedNode('x');
      renderNode();
      enterByDoubleClick();
      const el = editor() as HTMLElement;
      const inside = document.createElement('button');
      el.appendChild(inside);

      fireEvent.blur(el, { relatedTarget: inside });

      expect(editor()).not.toBeNull();
    });

    it('stays open when the whole window loses focus', () => {
      // Switching windows or tabs is not leaving the node — come back and the
      // caret should still be where it was, not a node that closed itself
      // while nobody was looking. `relatedTarget` cannot tell this apart from
      // a click on something unfocusable, so the check is whether the document
      // still has focus at all.
      seedNode('x');
      renderNode();
      enterByDoubleClick();
      const hasFocus = vi
        .spyOn(document, 'hasFocus')
        .mockReturnValue(false);

      fireEvent.blur(editor() as HTMLElement, { relatedTarget: null });

      expect(editor()).not.toBeNull();
      hasFocus.mockRestore();
    });

    // Where focus ENDS UP after either exit is asserted in CanvasSpace.test,
    // the one place that mounts a real ReactFlow: the node shell it hands
    // focus back to is ReactFlow's own element, and nothing rendered here
    // emits it. Asserted from this file, both exits move focus nowhere and the
    // assertion would pass whether the distinction existed or not.

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

    it('closes when the user is downgraded to viewer mid-edit', () => {
      // The third way a node stops being writable while somebody is inside it
      // (round-5): an admin revokes the editor role, the live role query flips
      // `readOnly`, and the person typing is now a viewer. Left open, the
      // editor keeps publishing their caret into shared awareness — a viewer
      // visibly "editing" — and it is one condition drifting from the other
      // two exits that lets it happen.
      seedNode('typed so far');
      const { rerender } = renderNode();
      enterByDoubleClick();
      expect(editor()).not.toBeNull();

      rerender(tree({ canvas: { readOnly: true } }));

      expect(editor()).toBeNull();
      expect(bodyToPlainText(body())).toBe('typed so far');
    });

    it('rebinds to the winner when a concurrent repair replaces the body', () => {
      // Two people opening the same body-less node each repair it, and one of
      // the two fragments loses. The loser's editor would go on accepting
      // keystrokes into an object no longer in the document: caret blinking,
      // words appearing, none of it reaching anybody or surviving a reload.
      seedNode();
      stripBody();
      renderNode();
      fireEvent.doubleClick(screen.getByTestId('node-placeholder'));
      expect(editor()).not.toBeNull();

      const winner = new Y.XmlFragment();
      winner.insert(0, [new Y.XmlElement('paragraph')]);
      act(() => {
        const data = getDoc(docName.canvasSpace(PID, SID))
          .getMap<Y.Map<unknown>>('nodesMap')
          .get(NODE)
          ?.get('data') as Y.Map<unknown>;
        data.set('body', winner);
      });

      // Still editing, and now bound to the fragment that actually won: text
      // written into it shows up in the editor.
      expect(editor()).not.toBeNull();
      act(() => {
        writePlainTextIntoBody(body(), 'from the winner');
      });
      expect(editor()?.textContent).toContain('from the winner');
    });

    it('closes when the body disappears entirely rather than binding to a ghost', () => {
      seedNode('x');
      renderNode();
      enterByDoubleClick();
      expect(editor()).not.toBeNull();

      act(() => {
        stripBody();
      });
      expect(editor()).toBeNull();
    });

    it('closes when the node fails mid-edit, and does not spring back when it recovers', () => {
      // Asserted across the recovery, because that is the only place the bug
      // shows. While the status is `error` the renderer gives the content slot
      // to the error message, so the editor is off screen either way and a
      // check there proves nothing — the same shape of empty test this round
      // is fixing elsewhere. If edit state was never cleared it is still set
      // when the node goes back to idle, and the editor reappears over
      // whatever just arrived, without anybody asking for it.
      seedNode('typed so far');
      const { rerender } = renderNode();
      enterByDoubleClick();
      expect(editor()).not.toBeNull();

      rerender(tree({ view: { status: 'error', errorMessage: 'upload failed' } }));
      expect(editor()).toBeNull();

      rerender(tree({ view: { status: 'idle' } }));

      expect(editor()).toBeNull();
      expect(screen.getByTestId('text-node-body')).toHaveTextContent('typed so far');
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
