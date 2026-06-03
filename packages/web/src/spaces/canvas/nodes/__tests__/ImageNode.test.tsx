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
        data={{ kind: 'image', url: 'https://e.com/x.jpg', status: 'idle' }}
      />,
    );
    expect(
      screen.getByTestId('image-node-img').getAttribute('src'),
    ).toBe('https://e.com/x.jpg');
  });

  it('handling status shows skeleton even with url', () => {
    render(
      <ImageNode
        data={{ kind: 'image', url: 'https://e.com/x', status: 'handling' }}
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

  it('clicking placeholder fires onActivate', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <ImageNode
        data={{ kind: 'image', status: 'idle' }}
        onActivate={onActivate}
      />,
    );
    await user.click(screen.getByTestId('node-placeholder'));
    expect(onActivate).toHaveBeenCalled();
  });
});
