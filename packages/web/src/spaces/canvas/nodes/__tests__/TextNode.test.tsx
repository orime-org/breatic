// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('double-clicking the body enters edit mode and commit fires onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TextNode
        data={{ kind: 'text', content: 'A', status: 'idle' }}
        onChange={onChange}
      />,
    );
    const body = screen.getByTestId('text-node-body');
    await user.dblClick(body);
    expect(body.getAttribute('contenteditable')).toBe('true');
    body.blur();
    expect(onChange).toHaveBeenCalled();
  });

  it('display state caps at 576 (max-h-144) and scrolls long content, NO line-clamp ellipsis (#5, supersedes #1445)', () => {
    // Not editing: the body keeps the 576px cap (max-h-144 = width 288 × 2) but
    // no longer truncates — the user reads the full text by scrolling (they know
    // double-click edits), with a slim custom scrollbar, not the OS default.
    // Reverses the #1445 line-clamp ellipsis.
    render(
      <TextNode data={{ kind: 'text', content: 'long text', status: 'idle' }} />,
    );
    const body = screen.getByTestId('text-node-body');
    expect(body.className).toContain('max-h-144');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).not.toContain('line-clamp');
    expect(body.className).toMatch(/scrollbar/);
  });

  it('the scrollable body carries ReactFlow `nowheel` so the wheel scrolls the text, not the canvas', () => {
    // Without `nowheel`, a wheel/two-finger scroll over the body is captured by
    // ReactFlow's panOnScroll and pans the canvas instead of scrolling the
    // overflowing text — the body shows a scrollbar but "won't scroll" (the
    // reported bug). `nowheel` tells ReactFlow to leave wheel events alone so the
    // element scrolls natively. Must hold in BOTH display and edit state.
    render(
      <TextNode data={{ kind: 'text', content: 'long text', status: 'idle' }} />,
    );
    expect(screen.getByTestId('text-node-body').className).toContain('nowheel');
  });

  it('keeps `nowheel` on the body while editing too (wheel still scrolls the text)', async () => {
    const user = userEvent.setup();
    render(
      <TextNode data={{ kind: 'text', content: 'long text', status: 'idle' }} />,
    );
    const body = screen.getByTestId('text-node-body');
    await user.dblClick(body);
    expect(body.className).toContain('nowheel');
  });

  it('edit state caps at 576 (max-h-144) and scrolls long content (#1445)', async () => {
    // Double-click → editing: same 576px cap, but overflow scrolls so the full
    // content is reachable while editing (no ellipsis truncation).
    const user = userEvent.setup();
    render(
      <TextNode data={{ kind: 'text', content: 'long text', status: 'idle' }} />,
    );
    const body = screen.getByTestId('text-node-body');
    await user.dblClick(body);
    expect(body.className).toContain('max-h-144');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).not.toContain('line-clamp');
    expect(body.className).toMatch(/scrollbar/);
  });
});
