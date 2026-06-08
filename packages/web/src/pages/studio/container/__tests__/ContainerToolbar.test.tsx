// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ContainerToolbar } from '@web/pages/studio/container/ContainerToolbar';

describe('ContainerToolbar', () => {
  it('draws NO bottom border — the tab strip already owns the divider (neutral mock §toolbar)', () => {
    render(
      <ContainerToolbar title='Projects' count={3} createLabel='New project' />,
    );
    // The neutral-direction mock removed the toolbar's own border-bottom because
    // it doubled the tab strip's line right above it. Locking that in: the
    // toolbar container must carry no bottom-border utility.
    const bar = screen.getByTestId('container-toolbar');
    expect(bar.className).not.toContain('border-b');
  });
});
