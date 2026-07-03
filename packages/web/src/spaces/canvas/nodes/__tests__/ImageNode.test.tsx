// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImageNode } from '@web/spaces/canvas/nodes/ImageNode';

describe('ImageNode', () => {
  it('renders placeholder when no url', () => {
    render(<ImageNode data={{ kind: 'image', status: 'idle' }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  it('renders the image when url is present', () => {
    render(
      <ImageNode
        data={{ kind: 'image', content: 'https://e.com/x.jpg', status: 'idle' }}
      />,
    );
    expect(
      screen.getByTestId('image-node-img').getAttribute('src'),
    ).toBe('https://e.com/x.jpg');
  });

  it('handling status shows skeleton even with url', () => {
    render(
      <ImageNode
        data={{ kind: 'image', content: 'https://e.com/x', status: 'handling' }}
      />,
    );
    expect(screen.getByTestId('node-content-handling')).toBeInTheDocument();
  });

  it('error status shows the error message', () => {
    render(
      <ImageNode
        data={{
          kind: 'image',
          status: 'error',
          errorMessage: '404',
        }}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent('404');
  });

  it('DOUBLE-clicking placeholder fires onActivate (opens upload); a single click does not', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <ImageNode
        data={{ kind: 'image', status: 'idle' }}
        onActivate={onActivate}
      />,
    );
    const ph = screen.getByTestId('node-placeholder');
    await user.click(ph);
    expect(onActivate).not.toHaveBeenCalled();
    await user.dblClick(ph);
    expect(onActivate).toHaveBeenCalled();
  });

  it('the shell clips the filled image - no corner gap (#1550 follow-up)', () => {
    render(
      <ImageNode
        data={{ kind: 'image', status: 'idle', content: 'blob:img' }}
      />,
    );
    // Concentric-radius geometry: the shell is rounded-sm (6px) + 1px border
    // with zero padding, so a child carrying its own 6px radius curves faster
    // than the border's inner arc and opens a gap in all four corners. The
    // shell clips every child to its rounded box; the img carries NO radius.
    expect(screen.getByTestId('image-node').className).toContain(
      'overflow-hidden',
    );
    expect(screen.getByTestId('image-node-img').className).not.toContain(
      'rounded',
    );
  });
});
