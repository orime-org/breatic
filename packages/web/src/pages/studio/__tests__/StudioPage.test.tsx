import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import StudioPage from '../StudioPage';
import { useStudioStore } from '@/stores';

function setup() {
  return render(
    <MemoryRouter>
      <StudioPage />
    </MemoryRouter>,
  );
}

describe('StudioPage', () => {
  beforeEach(() => {
    useStudioStore.setState({
      search: '',
      sortKey: 'updated',
      sortOrder: 'desc',
      filterOwnerOnly: false,
    });
  });

  it('renders Projects header + nav + grid by default', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Projects', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Projects/i })).toBeInTheDocument();
  });

  it('renders 3 demo project cards + 1 new card', () => {
    setup();
    // 3 demo cards link to /project/<id>; new card is a button.
    const links = screen.getAllByRole('link', { name: /Open project/i });
    expect(links).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Create new project' })).toBeInTheDocument();
  });

  it('switching to Settings renders Settings panel', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /Settings/i }));
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
  });

  it('search filter narrows visible cards', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByPlaceholderText('Search…'), 'cyber');
    const links = screen.getAllByRole('link', { name: /Open project/i });
    expect(links).toHaveLength(1);
    expect(screen.getByText('Cyberpunk Concept')).toBeInTheDocument();
  });
});
