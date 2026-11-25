// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The icon-only bar button shared by Motion and Timeline (inner#1709 design §6.1, moved from
 * `spaces/web-animation/motion-parts.tsx` to `components/BarButton.tsx`): its tooltip names it and, when it has one,
 * its shortcut after the name; the tooltip hangs on the wrapping span, so a disabled button still names itself on hover.
 */

import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Scissors, Undo2 } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BarButton } from '@web/components/BarButton';
import { renderWithTooltips } from '@web/test-utils/render-with-tooltips';

afterEach(() => { cleanup(); });

describe('BarButton (design §6.1)', () => {
  it('shows only its icon, named for the pointer by its tooltip, with the shortcut after the name', async () => {
    const user = userEvent.setup();
    renderWithTooltips(<BarButton testId='bar-split' label='Split' shortcut='⌘B' icon={<Scissors className='size-4' />} onClick={vi.fn()} />);
    const button = screen.getByTestId('bar-split');
    expect(button.textContent).toBe('');
    expect(button).toHaveAttribute('aria-label', 'Split');
    await user.hover(button);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Split');
    expect(tip.textContent).toContain('⌘B');
    expect(tip.textContent?.indexOf('Split')).toBeLessThan(tip.textContent?.indexOf('⌘B') ?? -1);
  });

  it('shows the name alone when it has no shortcut', async () => {
    const user = userEvent.setup();
    renderWithTooltips(<BarButton testId='bar-undo' label='Undo' icon={<Undo2 className='size-4' />} onClick={vi.fn()} />);
    await user.hover(screen.getByTestId('bar-undo'));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Undo');
  });

  it('still names a disabled button, with its shortcut, when the pointer rests on it', async () => {
    const user = userEvent.setup();
    renderWithTooltips(<BarButton testId='bar-undo' label='Undo' shortcut='⌘Z' disabled icon={<Undo2 className='size-4' />} onClick={vi.fn()} />);
    const button = screen.getByTestId('bar-undo');
    expect(button).toBeDisabled();
    const wrapper = button.parentElement;
    if (wrapper === null) throw new Error('The button has no wrapper');
    await user.hover(wrapper);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Undo');
    expect(tip.textContent).toContain('⌘Z');
  });

  it('marks a pressed switch and a dimmed, still clickable unavailable button', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    renderWithTooltips(<>
      <BarButton testId='bar-pressed' label='Magnet' pressed icon={<Scissors className='size-4' />} onClick={vi.fn()} />
      <BarButton testId='bar-unavailable' label='Split' unavailable icon={<Scissors className='size-4' />} onClick={onClick} />
    </>);
    expect(screen.getByTestId('bar-pressed')).toHaveAttribute('aria-pressed', 'true');
    const unavailable = screen.getByTestId('bar-unavailable');
    expect(unavailable).toHaveAttribute('aria-disabled', 'true');
    expect(unavailable).not.toBeDisabled();
    await user.click(unavailable);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
