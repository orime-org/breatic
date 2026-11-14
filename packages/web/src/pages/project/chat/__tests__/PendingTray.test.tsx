// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The waiting area above the composer (inner#1717): the messages the server
 * holds for the Agent to read, each with what it carries and two buttons to
 * take it back into the box or delete it, which wait while the server
 * answers; why they wait, when a card or the balance holds them.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatPendingItem } from '@breatic/shared';
import { t } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { PendingTray } from '@web/pages/project/chat/PendingTray';

/** An attached item. */
const CHIP = { id: 'chip-1', type: 'text' as const, name: 'notes.txt', data_snapshot: { text: 'n' } };

/** Two waiting messages. */
const ITEMS: ChatPendingItem[] = [
  { id: 'm1', sentAt: '2026-11-12T08:00:00.000Z', words: 'make it blue', chips: [CHIP] },
  { id: 'm2', sentAt: '2026-11-12T08:01:00.000Z', words: 'and bigger', chips: [] },
];

/**
 * Render the tray.
 * @param props - What differs from two items with nothing busy.
 * @returns The take-back handler.
 */
function setup(props: Partial<Parameters<typeof PendingTray>[0]> = {}): ReturnType<typeof vi.fn> {
  const onTakeBack = vi.fn();
  render(
    <TooltipProvider>
      <PendingTray items={ITEMS} awaiting={false} blocked={false} busy={{}} onTakeBack={onTakeBack} {...props} />
    </TooltipProvider>,
  );
  return onTakeBack;
}

describe('the waiting area', () => {
  it('draws each waiting message with what it carries, and how many wait (WB-03)', () => {
    setup();
    expect(screen.getByTestId('chat-waiting-tray')).toHaveTextContent(t('chat.waiting.title', { count: 2 }));
    const rows = screen.getAllByTestId('chat-waiting-item');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('make it blue');
    expect(within(rows[0]!).getByText('notes.txt')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('and bigger');
  });

  it('takes a message back into the box, or deletes it (WB-20, WB-21)', () => {
    const onTakeBack = setup();
    const [first] = screen.getAllByTestId('chat-waiting-item');
    fireEvent.click(within(first!).getByTestId('chat-waiting-retract'));
    fireEvent.click(within(first!).getByTestId('chat-waiting-delete'));
    expect(onTakeBack.mock.calls).toEqual([
      [ITEMS[0], 'retract'],
      [ITEMS[0], 'delete'],
    ]);
  });

  it('shows the button pressed waiting, and takes no second press meanwhile (WB-20)', () => {
    const onTakeBack = setup({ busy: { m1: 'retract' } });
    const [first] = screen.getAllByTestId('chat-waiting-item');
    const retract = within(first!).getByTestId('chat-waiting-retract');
    expect(retract).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(retract);
    expect(onTakeBack).not.toHaveBeenCalled();
  });

  it('says a card waits for an answer first, in words that fit a questionnaire and a Space request alike (WB-14)', () => {
    setup({ awaiting: true });
    expect(screen.getByTestId('chat-waiting-tray')).toHaveTextContent(t('chat.waiting.awaitingCard'));
    expect(screen.getByTestId('chat-waiting-note').textContent).toBe('Answer the card above to go on, or just send a message.');
  });

  it('says the balance is short, and still lets each message be taken back (WB-15)', () => {
    setup({ blocked: true });
    expect(screen.getByTestId('chat-waiting-tray')).toHaveTextContent(t('chat.waiting.blocked'));
    expect(screen.getAllByTestId('chat-waiting-retract')).toHaveLength(2);
    expect(screen.getAllByTestId('chat-waiting-delete')).toHaveLength(2);
  });

  it.each([
    ['a card waits', { awaiting: true }, 'chat.waiting.awaitingCard'],
    ['the balance is short', { blocked: true }, 'chat.waiting.blocked'],
  ] as const)('puts why they wait on a line of its own under the title when %s, so the title stays whole', (_, props, key) => {
    setup(props);
    const title = screen.getByTestId('chat-waiting-title');
    const note = screen.getByTestId('chat-waiting-note');
    expect(title).toHaveTextContent(t('chat.waiting.title', { count: 2 }));
    expect(title).not.toContainElement(note);
    expect(note).toHaveTextContent(t(key));
    expect(title.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws no note line while nothing holds the messages', () => {
    setup();
    expect(screen.queryByTestId('chat-waiting-note')).toBeNull();
  });

  it('draws nothing while nothing waits', () => {
    setup({ items: [] });
    expect(screen.queryByTestId('chat-waiting-tray')).toBeNull();
  });
});
