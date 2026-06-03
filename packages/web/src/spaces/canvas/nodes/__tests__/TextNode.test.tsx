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
});
