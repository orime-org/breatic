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

  it('caps the body height and scrolls long content (max-h-108 + overflow)', () => {
    // A long text node must not stretch the whole canvas — the body caps at a
    // max height and scrolls inside; reading the rest is an in-node scroll, not
    // a whole-canvas pan.
    render(
      <TextNode data={{ kind: 'text', content: 'long text', status: 'idle' }} />,
    );
    const body = screen.getByTestId('text-node-body');
    expect(body.className).toContain('max-h-108');
    expect(body.className).toContain('overflow-y-auto');
  });
});
