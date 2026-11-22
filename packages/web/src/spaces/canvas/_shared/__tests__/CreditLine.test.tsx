// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The cost beside a run button: a credit figure behind the credits star, or the key a run uses (inner#1953). */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { CreditLine } from '@web/spaces/canvas/_shared/CreditLine';

describe('CreditLine', () => {
  it('shows a credit figure behind the credits star, on one line', () => {
    render(<CreditLine text='6' testId='cost' />);
    const line = screen.getByTestId('cost');

    expect(line).toHaveTextContent('6');
    expect(line.querySelector('[data-icon="credits"]')).not.toBeNull();
    expect(line.className).toContain('whitespace-nowrap');
  });

  it('shows a run on a key behind the key mark, with the full sentence on hover', async () => {
    const user = userEvent.setup();
    render(<TooltipProvider><CreditLine text='Your key' detail='Uses your key, no credits' testId='cost' /></TooltipProvider>);
    const line = screen.getByTestId('cost');

    expect(line).toHaveTextContent('Your key');
    expect(line.querySelector('[data-icon="key"]')).not.toBeNull();
    expect(line.querySelector('[data-icon="credits"]')).toBeNull();
    expect(line.className).toContain('whitespace-nowrap');
    await user.hover(line);
    expect((await screen.findAllByText('Uses your key, no credits')).length).toBeGreaterThan(0);
  });

  it('draws credits a keyed run also takes behind the credits star, after the key mark', () => {
    render(<TooltipProvider><CreditLine text='Your key' detail='Uses your key; describing elements takes credits' also='credits' testId='cost' /></TooltipProvider>);
    const line = screen.getByTestId('cost');

    expect(line).toHaveTextContent('Your key+credits');
    const icons = [...line.querySelectorAll('[data-icon]')].map((icon) => icon.getAttribute('data-icon'));
    expect(icons).toEqual(['key', 'credits']);
  });
});
