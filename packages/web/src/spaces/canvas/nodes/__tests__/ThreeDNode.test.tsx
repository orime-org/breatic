// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ThreeDNode } from '@web/spaces/canvas/nodes/ThreeDNode';

describe('ThreeDNode', () => {
  it('renders placeholder when no url', () => {
    render(<ThreeDNode data={{ kind: '3d', status: 'idle' }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  it('renders the stub renderer when url is present', () => {
    render(
      <ThreeDNode
        data={{
          kind: '3d',
          content: 'https://e.com/x.glb',
          status: 'idle',
        }}
      />,
    );
    expect(screen.getByTestId('three-d-node-stub')).toHaveTextContent(
      'https://e.com/x.glb',
    );
  });

  it('keeps showing what it holds while a task runs on it', () => {
    // Covering the content took away the thing the reader came for; the
    // counts beside the node already say something is working
    // (user 2026-09-06).
    render(
      <ThreeDNode data={{ kind: '3d', status: 'handling', content: 'x' }} />,
    );
    expect(screen.queryByTestId('node-content-handling')).not.toBeInTheDocument();
  });
});
