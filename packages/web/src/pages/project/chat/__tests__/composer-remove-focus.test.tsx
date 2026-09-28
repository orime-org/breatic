// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the keyboard goes when an attached item is taken out: onto the next
 * item's remove button, the previous one's when it was the last, and the box
 * when none are left -- never back to the top of the page.
 */

import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import type { TrayItem } from '@web/stores/chat-attachments';

afterEach(cleanup);

const item = (id: string): TrayItem => ({
  id,
  name: `Item ${id}`,
  type: 'text',
  status: 'ready',
  chip: { id, type: 'text', name: `Item ${id}`, data_snapshot: { text: 'words' } },
});

/**
 * The composer holding a tray the test can take items out of.
 * @param root0 - The props.
 * @param root0.ids - The items it starts with.
 * @returns The composer.
 */
function Tray({ ids }: { ids: string[] }): React.JSX.Element {
  const [items, setItems] = React.useState(() => ids.map(item));
  return (
    <ChatComposer
      draft=''
      onChange={() => undefined}
      onSubmit={() => undefined}
      onAttachFiles={() => undefined}
      attachments={items}
      onRemoveAttachment={(id) => setItems((now) => now.filter((i) => i.id !== id))}
    />
  );
}

/**
 * Presses the remove button of one item, as a keyboard user would.
 * @param id - The item.
 */
function removeWithKeyboard(id: string): void {
  const button = screen.getByTestId(`chat-chip-${id}`).querySelector('button');
  if (!button) throw new Error(`no remove button on ${id}`);
  button.focus();
  fireEvent.click(button);
}

describe('taking an attached item out', () => {
  it('hands the keyboard to the next item', () => {
    render(<Tray ids={['a', 'b', 'c']} />);
    removeWithKeyboard('b');

    expect(document.activeElement).toBe(screen.getByTestId('chat-chip-c').querySelector('button'));
  });

  it('hands the keyboard to the previous item when the last one goes', () => {
    render(<Tray ids={['a', 'b']} />);
    removeWithKeyboard('b');

    expect(document.activeElement).toBe(screen.getByTestId('chat-chip-a').querySelector('button'));
  });

  it('hands the keyboard to the box when none are left', () => {
    render(<Tray ids={['a']} />);
    removeWithKeyboard('a');

    expect(document.activeElement).toBe(screen.getByTestId('chat-composer-textarea'));
  });
});
