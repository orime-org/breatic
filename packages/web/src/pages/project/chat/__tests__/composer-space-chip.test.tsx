// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chip right of the plus sign (inner#1413): it always names the Space
 * whose tab is active, and pressing it turns sending that Space to the Agent
 * on and off.
 */

import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import type { SpaceContextChipProps } from '@web/pages/project/chat/SpaceContextChip';

/** What a test changes about the chip, or null for no open Space. */
interface ChipSetup {
  space?: Partial<SpaceContextChipProps> | null;
  turnPhase?: Parameters<typeof ChatComposer>[0]['turnPhase'];
}

/**
 * Render the composer with an open Space's chip.
 * @param options - What this case changes.
 * @returns The toggle handler.
 */
function setup(options: ChipSetup = {}): { onToggleSpace: ReturnType<typeof vi.fn> } {
  const onToggleSpace = vi.fn();
  const space =
    options.space === null
      ? undefined
      : { name: 'Storyboard', type: 'document' as const, enabled: true, onToggle: onToggleSpace, ...options.space };
  // The app's one provider lives in App.tsx; a test stands in for it.
  render(
    <TooltipProvider>
      <ChatComposer
        draft=''
        onChange={() => undefined}
        onSubmit={() => undefined}
        {...(space ? { space } : {})}
        {...(options.turnPhase ? { turnPhase: options.turnPhase } : {})}
      />
    </TooltipProvider>,
  );
  return { onToggleSpace };
}

describe('the open Space chip', () => {
  it('names the open Space after the plus sign', () => {
    setup();

    const chip = screen.getByTestId('chat-composer-space');
    expect(chip).toHaveTextContent('Storyboard');
    const attach = screen.getByTestId('chat-composer-attach');
    expect(attach.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shrinks with a long name down to its icon and three full-width characters, and no further', () => {
    // Without a floor of its own the chip is either never narrower than its
    // text, pushing it over the send button, or squeezed past its icon by a
    // long notice beside it. The floor is the padding, border, icon and gap
    // (34px) plus three characters, counted in em so a CJK name keeps three.
    setup({ space: { name: 'A very long space name that goes on and on and on' } });

    const chip = screen.getByTestId('chat-composer-space');
    expect(chip.className).toContain('min-w-[calc(3em+2.125rem)]');
    expect(chip.className).toContain('overflow-hidden');
  });

  it('is not drawn when no Space is open', () => {
    setup({ space: null });

    expect(screen.queryByTestId('chat-composer-space')).toBeNull();
  });

  it('reads as pressed while on, with the attachment look', () => {
    setup();

    const chip = screen.getByTestId('chat-composer-space');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip.className).toContain('bg-chip');
    expect(chip.className).not.toContain('border-dashed');
  });

  it('reads as not pressed while off, with a dashed border and muted words', () => {
    setup({ space: { enabled: false } });

    const chip = screen.getByTestId('chat-composer-space');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip.className).toContain('border-dashed');
    expect(chip.className).toContain('text-muted-foreground');
    // Stays unfilled under the pointer, which is where it is right after the
    // press that turned it off.
    expect(chip.className).not.toMatch(/hover:bg-/);
    expect(chip).toHaveTextContent('Storyboard');
  });

  it('asks to turn it over when pressed', async () => {
    const { onToggleSpace } = setup();

    await userEvent.click(screen.getByTestId('chat-composer-space'));

    expect(onToggleSpace).toHaveBeenCalledTimes(1);
  });

  it('can still be turned over while a reply is being written', async () => {
    const { onToggleSpace } = setup({ turnPhase: 'running' });

    await userEvent.click(screen.getByTestId('chat-composer-space'));

    expect(onToggleSpace).toHaveBeenCalledTimes(1);
  });

  describe('what hovering it says', () => {
    /**
     * Point at the chip long enough for its tooltip to open.
     * @returns The tooltip's words.
     */
    const hoverText = (): string => {
      vi.useFakeTimers();
      fireEvent.pointerMove(screen.getByTestId('chat-composer-space'), { pointerType: 'mouse' });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const words = screen.getAllByRole('tooltip').map((el) => el.textContent ?? '').join(' ');
      vi.useRealTimers();
      return words;
    };

    it('says a click stops the Agent reading the open Space while it is on', () => {
      setup();
      expect(hoverText()).toBe('Click to stop the Agent reading this Space');
    });

    it('says the Agent knows an open timeline is open but cannot read it, and a click stops that', () => {
      setup({ space: { name: 'Edit', type: 'timeline' } });
      expect(hoverText()).toBe('The Agent knows you have this Space open but can\'t read its content. Click to stop');
    });

    it('says a click lets the Agent read it while it is off', () => {
      setup({ space: { enabled: false } });
      expect(hoverText()).toBe('Click to let the Agent read this Space');
    });

    it('says a click lets the Agent know an open timeline is open while it is off', () => {
      setup({ space: { name: 'Edit', type: 'timeline', enabled: false } });
      expect(hoverText()).toBe('Click to let the Agent know you have this Space open');
    });
  });
});
