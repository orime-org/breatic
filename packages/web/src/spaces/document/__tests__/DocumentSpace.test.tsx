import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DocumentSpace } from '@web/spaces/document/DocumentSpace';

describe('DocumentSpace', () => {
  it('renders the editor mount and the toolbar', async () => {
    render(<DocumentSpace projectId='p1' spaceId='doc-1' />);
    expect(await screen.findByTestId('document-space')).toBeInTheDocument();
    expect(screen.getByTestId('document-toolbar')).toBeInTheDocument();
  });

  it('forwards projectId / spaceId via data attributes', async () => {
    render(<DocumentSpace projectId='alpha' spaceId='beta' />);
    const root = await screen.findByTestId('document-space');
    expect(root.getAttribute('data-project-id')).toBe('alpha');
    expect(root.getAttribute('data-space-id')).toBe('beta');
  });

  it('exposes the 6 starter-kit toggles in the toolbar', async () => {
    render(<DocumentSpace projectId='p' spaceId='s' />);
    await screen.findByTestId('document-toolbar');
    expect(screen.getByTestId('doc-tool-bold')).toBeInTheDocument();
    expect(screen.getByTestId('doc-tool-italic')).toBeInTheDocument();
    expect(screen.getByTestId('doc-tool-strike')).toBeInTheDocument();
    expect(screen.getByTestId('doc-tool-bullet-list')).toBeInTheDocument();
    expect(screen.getByTestId('doc-tool-ordered-list')).toBeInTheDocument();
    expect(screen.getByTestId('doc-tool-quote')).toBeInTheDocument();
  });
});
