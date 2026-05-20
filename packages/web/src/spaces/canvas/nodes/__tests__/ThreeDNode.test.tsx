import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ThreeDNode } from '@/spaces/canvas/nodes/ThreeDNode';

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
          url: 'https://e.com/x.glb',
          status: 'idle',
        }}
      />,
    );
    expect(screen.getByTestId('three-d-node-stub')).toHaveTextContent(
      'https://e.com/x.glb',
    );
  });

  it('handling status shows the loading skeleton', () => {
    render(
      <ThreeDNode data={{ kind: '3d', status: 'handling', url: 'x' }} />,
    );
    expect(screen.getByTestId('node-content-handling')).toBeInTheDocument();
  });
});
