// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A choice menu row with a hint keeps the hint readable on the held row's
 * fill (inner#2192): muted text sits under 4.5:1 there, so that row and a
 * hovered one use the row token.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChoiceMenu } from '@web/spaces/canvas/generate/ChoiceMenu';

const OPTIONS = [
  { value: 'single', label: 'Single shot', testId: 'opt-single' },
  { value: 'multi', label: 'Multi-shot', hint: 'Write each shot yourself', testId: 'opt-multi' },
  { value: 'auto', label: 'Auto multi-shot', hint: 'The model plans the shots', testId: 'opt-auto' },
];

describe('ChoiceMenu hints', () => {
  it('shows the held row’s hint in the row token and the others muted until hovered', () => {
    render(<ChoiceMenu value='multi' options={OPTIONS} onSelect={() => undefined} triggerTestId='trigger' triggerClassName='' />);
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByText('Write each shot yourself')).toHaveClass('text-row-foreground-muted');
    expect(screen.getByText('The model plans the shots')).toHaveClass('text-muted-foreground', 'group-hover/row:text-row-foreground-muted');
  });
});
