// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TextNode } from '@web/spaces/canvas/nodes/TextNode';

describe('TextNode', () => {
  it('renders placeholder when content is empty + status=idle', () => {
    render(<TextNode data={{ kind: 'text', content: '', status: 'idle' }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  it('renders the content body when content is present', () => {
    render(
      <TextNode
        data={{ kind: 'text', content: 'Hello world', status: 'idle' }}
      />,
    );
    expect(screen.getByTestId('text-node-body')).toHaveTextContent(
      'Hello world',
    );
  });

  it('handling status surfaces the loading skeleton', () => {
    render(
      <TextNode data={{ kind: 'text', content: 'x', status: 'handling' }} />,
    );
    expect(screen.getByTestId('node-content-handling')).toBeInTheDocument();
  });

  it('error status surfaces the error message', () => {
    render(
      <TextNode
        data={{
          kind: 'text',
          content: 'x',
          status: 'error',
          errorMessage: 'Boom',
        }}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent('Boom');
  });

  it('does not expose editable affordances on the body when not editing', () => {
    // Root-cause invariant: ReactFlow's isInputDOMNode treats ANY element
    // carrying a `contenteditable` attribute as an input — the value ("false")
    // is ignored — and swallows the Delete key. A focusable body also steals
    // the click focus away from node selection. So a non-editing, content-filled
    // text node must NOT advertise contenteditable / tabindex / a textbox role,
    // otherwise the node cannot be deleted by keyboard (the reported bug).
    render(
      <TextNode data={{ kind: 'text', content: 'Hello', status: 'idle' }} />,
    );
    const body = screen.getByTestId('text-node-body');
    expect(body.hasAttribute('contenteditable')).toBe(false);
    expect(body.hasAttribute('tabindex')).toBe(false);
    expect(body.getAttribute('role')).not.toBe('textbox');
  });

  it('SELECTING the node (no double-click) does NOT enter edit mode — only double-click does (#1470)', () => {
    // Selection is single-click; editing is double-click. A selected-but-not-
    // double-clicked text node stays in the display state (clipped, no
    // contenteditable) — editing is never triggered by selection alone.
    render(
      <TextNode
        data={{ kind: 'text', content: 'Hello', status: 'idle' }}
        selected
      />,
    );
    const body = screen.getByTestId('text-node-body');
    expect(body.getAttribute('contenteditable')).not.toBe('true');
    expect(body.className).toContain('overflow-hidden');
    expect(body.className).not.toContain('overflow-y-auto');
  });

  it('double-clicking the body enters edit mode and commit fires onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TextNode
        data={{ kind: 'text', content: 'A', status: 'idle' }}
        onChange={onChange}
      />,
    );
    await user.dblClick(screen.getByTestId('text-node-body'));
    // Entering edit mode remounts the body inside a ScrollArea (#1773) —
    // re-query instead of holding the pre-click element.
    const body = screen.getByTestId('text-node-body');
    expect(body.getAttribute('contenteditable')).toBe('true');
    body.blur();
    expect(onChange).toHaveBeenCalled();
  });

  it('display state caps at 576 (max-h-144) and CLIPS overflow — no scrollbar, two-state (supersedes #5 scroll-both, #1470)', () => {
    // Not editing: cap at 576px (max-h-144 = width 288 × 2) but CLIP the overflow
    // (overflow-hidden) — NO scrollbar. The wheel zooms the canvas here (no
    // `nowheel` in display state, #1479), so a scrollbar you cannot scroll is
    // dead weight; a bottom fade gradient hints "there's more" and double-click
    // edits + scrolls. Long unbreakable tokens wrap (break-words) instead of
    // forcing a horizontal scrollbar (the reported #1470 horizontal-scroll bug).
    render(
      <TextNode data={{ kind: 'text', content: 'long text', status: 'idle' }} />,
    );
    const body = screen.getByTestId('text-node-body');
    expect(body.className).toContain('max-h-144');
    expect(body.className).toContain('overflow-hidden');
    expect(body.className).not.toContain('overflow-y-auto');
    expect(body.className).not.toMatch(/scrollbar/);
    expect(body.className).toContain('break-words');
    // A node is always at least the empty-state height (h-48 = 192px), grows with
    // content up to the cap — never the old cramped 48px (min-h-[3rem]).
    expect(body.className).toContain('min-h-48');
    expect(body.className).not.toContain('min-h-[3rem]');
  });

  it('does NOT flash the placeholder after committing a fresh node — holds the typed text until the prop syncs (#1470)', async () => {
    // The Yjs write is async: commit() flips `editing` off synchronously while
    // `data.content` (the prop) catches up a tick later. For a FRESH node
    // (content was "") that gap renders the empty-state placeholder for one
    // frame — the reported flash. A local committed-draft must bridge the gap so
    // the just-typed text stays on screen (no placeholder) until the prop lands.
    const user = userEvent.setup();
    // onChange is a no-op here → `data.content` stays "" (simulates the prop not
    // yet reflecting the async Yjs write).
    render(
      <TextNode
        data={{ kind: 'text', content: '', status: 'idle' }}
        onChange={() => undefined}
      />,
    );
    await user.dblClick(screen.getByTestId('node-placeholder'));
    const body = screen.getByTestId('text-node-body');
    // jsdom has no `innerText` (the getter returns undefined); commit() reads it,
    // so define it from textContent on this element to mirror the browser.
    Object.defineProperty(body, 'innerText', {
      configurable: true,
      get(): string {
        return this.textContent ?? '';
      },
    });
    body.textContent = '1111';
    fireEvent.blur(body); // fireEvent wraps in act → commit's state update flushes
    // After commit: editing is off and the prop is still "" — but the body must
    // keep showing the committed text, NOT revert to the placeholder.
    expect(screen.queryByTestId('node-placeholder')).toBeNull();
    expect(screen.getByTestId('text-node-body')).toHaveTextContent('1111');
  });

  it('empty text node: double-clicking the placeholder enters edit mode (write), showing the editable body', async () => {
    const user = userEvent.setup();
    render(<TextNode data={{ kind: 'text', content: '', status: 'idle' }} />);
    // Empty → placeholder is shown first.
    await user.dblClick(screen.getByTestId('node-placeholder'));
    // Now editing: the contenteditable body renders even though there is no
    // content yet, so the user can start writing.
    expect(
      screen.getByTestId('text-node-body').getAttribute('contenteditable'),
    ).toBe('true');
  });

  it('display state does NOT carry `nowheel` — the wheel zooms the canvas like other nodes (#1479)', () => {
    // A non-editing text node is part of the canvas: wheeling over it must zoom
    // the canvas (consistent with image nodes), NOT be swallowed by the body.
    // The display body clips (no scroll), so there is nothing to scroll anyway —
    // `nowheel` here would only break canvas zoom (the reported #1479 bug).
    render(
      <TextNode data={{ kind: 'text', content: 'long text', status: 'idle' }} />,
    );
    const body = screen.getByTestId('text-node-body');
    expect(body.className).not.toContain('nowheel');
    expect(body.closest('.nowheel')).toBeNull();
  });

  it('adds `nowheel` on the body ONLY while editing (wheel scrolls the text you are editing)', async () => {
    const user = userEvent.setup();
    render(
      <TextNode data={{ kind: 'text', content: 'long text', status: 'idle' }} />,
    );
    await user.dblClick(screen.getByTestId('text-node-body'));
    // While editing, `nowheel` + `nodrag` sit on the ScrollArea root (#1773)
    // — ReactFlow checks ancestors, so the gate still covers the body.
    const body = screen.getByTestId('text-node-body');
    expect(body.closest('.nowheel')).not.toBeNull();
    expect(body.closest('.nodrag')).not.toBeNull();
  });

  it('edit state caps at 576 (max-h-144), SCROLLS, wraps long tokens, starts at the empty-state height (#1470)', async () => {
    // Double-click → editing: same 576px cap, but overflow SCROLLS — inside a
    // ScrollArea (#1773 overlay scrollbar: appears only while scrolling, no
    // layout space, hover changes color only) so the full content is reachable
    // while editing; long unbreakable tokens wrap (break-words). The box starts
    // at the empty-state height (min-h-48 = 192px), not the old cramped 48px,
    // and grows with content up to the cap.
    const user = userEvent.setup();
    render(
      <TextNode data={{ kind: 'text', content: 'long text', status: 'idle' }} />,
    );
    await user.dblClick(screen.getByTestId('text-node-body'));
    const body = screen.getByTestId('text-node-body');
    // The 576px cap sits on the ScrollArea VIEWPORT (the scroller); the body
    // keeps the min height + wrapping so the whole empty area takes the caret.
    const viewport = body.closest('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    expect((viewport as HTMLElement).className).toContain('max-h-144');
    expect(body.className).toContain('break-words');
    expect(body.className).toContain('min-h-48');
    expect(body.className).not.toContain('min-h-[3rem]');
  });

  it('editing body shows the text cursor, not the inherited grab hand (user bug 2026-07-04)', async () => {
    const user = userEvent.setup();
    render(<TextNode data={{ kind: 'text', status: 'idle', content: 'hello' }} />);
    await user.dblClick(screen.getByTestId('text-node-body'));
    const body = screen.getByTestId('text-node-body');
    // contenteditable has NO UA cursor of its own - it inherits the ReactFlow
    // node wrapper's grab hand unless the editing class declares cursor-text.
    expect(body.getAttribute('contenteditable')).toBe('true');
    expect(body.className).toContain('cursor-text');
  });
});
