// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chip right of the plus sign (inner#1413): it always names the Space
 * whose tab is active, and pressing it turns sending that Space to the Agent
 * on and off.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { ChatComposer } from '@web/pages/project/chat/ChatComposer';

/**
 * Render the composer with the chip's props.
 * @param props - What this case changes.
 * @returns The toggle handler.
 */
function setup(props: Partial<Parameters<typeof ChatComposer>[0]> = {}): { onToggleSpace: ReturnType<typeof vi.fn> } {
  const onToggleSpace = vi.fn();
  // The app's one provider lives in App.tsx; a test stands in for it.
  render(
    <TooltipProvider>
      <ChatComposer
        draft=''
        onChange={() => undefined}
        onSubmit={() => undefined}
        spaceName='Storyboard'
        spaceType='document'
        spaceEnabled
        onToggleSpace={onToggleSpace}
        {...props}
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

  it('is not drawn when no Space is open', () => {
    setup({ spaceName: undefined, spaceType: undefined });

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
    setup({ spaceEnabled: false });

    const chip = screen.getByTestId('chat-composer-space');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip.className).toContain('border-dashed');
    expect(chip.className).toContain('text-muted-foreground');
    // Stays unfilled under the pointer, which is where it is right after the
    // press that turned it off.
    expect(chip.className).toContain('hover:bg-transparent');
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
});
