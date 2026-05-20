import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SpaceOutlet } from '@/pages/project/SpaceOutlet';

describe('SpaceOutlet', () => {
  it('renders the canvas body for type=canvas', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    expect(screen.getByTestId('canvas-space')).toBeInTheDocument();
  });

  it('renders the document body for type=document', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='document' />);
    expect(screen.getByTestId('document-space')).toBeInTheDocument();
  });

  it('renders the timeline body for type=timeline (empty state)', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='timeline' />);
    expect(screen.getByTestId('timeline-space-empty')).toBeInTheDocument();
  });
});
