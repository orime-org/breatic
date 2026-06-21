// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';

describe('ContentNodeFrame', () => {
  // #1449: the frame renders the name header (not the modality body), so it must
  // thread `selected` down to NodeHeader for the active-name colour to work.
  // Selected → the name uses the strong foreground; unselected → muted.
  it('selected: threads selection to the header (strong foreground name)', () => {
    render(
      <ContentNodeFrame modality='image' name='Hero' selected>
        <div />
      </ContentNodeFrame>,
    );
    expect(screen.getByTestId('node-header')).toHaveClass('text-foreground');
  });

  it('unselected: the name dims to the muted foreground', () => {
    render(
      <ContentNodeFrame modality='image' name='Hero'>
        <div />
      </ContentNodeFrame>,
    );
    expect(screen.getByTestId('node-header')).toHaveClass(
      'text-muted-foreground',
    );
  });
});
