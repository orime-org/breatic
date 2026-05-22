import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import type { ProjectSummary } from '@/data/api/projects';
import { ProjectCard } from '@/pages/studio/grid/ProjectCard';

const project: ProjectSummary = {
  id: 'p1',
  name: 'Cyberpunk Concept',
  description: null,
  thumbnailUrl: null,
  createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
  updatedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
};

function setup(p: ProjectSummary = project) {
  return render(
    <MemoryRouter>
      {/* eslint-disable-next-line jsx-a11y/aria-role -- `role` here is a ProjectCard component prop, not a DOM ARIA role */}
      <ProjectCard project={p} role='owner' />
    </MemoryRouter>,
  );
}

describe('ProjectCard', () => {
  it('renders the project name', () => {
    setup();
    expect(screen.getByText('Cyberpunk Concept')).toBeInTheDocument();
  });

  it('links to /project/<id>', () => {
    setup();
    const link = screen.getByRole('link', { name: /Open project/i });
    expect(link.getAttribute('href')).toBe('/project/p1');
  });

  it('renders role badge (Owner / Edit / View)', () => {
    setup();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('renders relative updated time (m ago / h ago / d ago)', () => {
    setup();
    expect(screen.getByText(/ago/i)).toBeInTheDocument();
  });

  it('renders thumbnail img when thumbnailUrl present', () => {
    const { container } = setup({
      ...project,
      thumbnailUrl: 'https://example.com/x.jpg',
    });
    // Thumbnail is decorative (alt=""), so role is presentation, not img.
    // Query by tag to avoid coupling the test to a non-semantic role choice.
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.com/x.jpg');
  });
});
