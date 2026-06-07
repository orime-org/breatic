// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StudioSelectField } from '@web/pages/studio/container/dialogs/StudioSelectField';

const STUDIOS = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
] as const;

describe('StudioSelectField (spec §7.1 — create-project studio selector)', () => {
  it('renders the label tied to the combobox', () => {
    render(
      <StudioSelectField
        studios={STUDIOS}
        value='a'
        onChange={() => {}}
        label='Studio'
      />,
    );
    expect(screen.getByText('Studio')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('displays the selected studio name in the trigger', () => {
    render(
      <StudioSelectField
        studios={STUDIOS}
        value='b'
        onChange={() => {}}
        label='Studio'
      />,
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('Beta');
  });
});
