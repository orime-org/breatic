// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Folder } from 'lucide-react';

import { EmptyState } from '@web/pages/studio/shared/EmptyState';

describe('EmptyState (neutral mock §empty — shared across studio empty views)', () => {
  it('renders the title + hint', () => {
    render(
      <EmptyState icon={Folder} title='Nothing here' hint='Add one to begin' />,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Add one to begin')).toBeInTheDocument();
  });

  it('renders no action button when action is omitted', () => {
    render(<EmptyState icon={Folder} title='T' hint='H' />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders an action button that fires onClick when action is given', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={Folder}
        title='T'
        hint='H'
        action={{ label: 'New project', onClick }}
      />,
    );
    const btn = screen.getByRole('button', { name: /New project/i });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
