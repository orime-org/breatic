// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the composer takes up when there is nothing in it.
 *
 * It sits at the foot of the column and everything above it is the
 * conversation, so every row it keeps for itself is a row of the conversation
 * the reader does not get. Empty, it is one line of box and one row of
 * controls; the row that carries references appears when there are references
 * to carry.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import type { TrayItem } from '@web/stores/chat-attachments';

/** What the composer needs to render at all. */
const BASICS = {
  draft: '',
  onChange: (): void => undefined,
  onSubmit: (): void => undefined,
  onAttachFiles: (): void => undefined,
  onRemoveAttachment: (): void => undefined,
};

/** One attached item, ready to go. */
const NOTE: TrayItem = {
  id: 'n1',
  name: 'A node',
  type: 'text',
  status: 'ready',
  chip: { id: 'n1', type: 'text', name: 'A node', data_snapshot: {} },
};

afterEach(cleanup);

describe('the row that carries references', () => {
  it('is not there at all when there are none', () => {
    render(<ChatComposer {...BASICS} />);

    expect(screen.queryByTestId('chat-composer-chips')).not.toBeInTheDocument();
  });

  it('appears once a reference is picked up', () => {
    render(<ChatComposer {...BASICS} attachments={[NOTE]} />);

    expect(screen.getByTestId('chat-composer-chips')).toBeInTheDocument();
  });

  it('leaves the button that attaches files in the row below', () => {
    // The row above holds what is attached, and holding a control in it is
    // what made it a row that could never go away.
    render(<ChatComposer {...BASICS} attachments={[NOTE]} />);

    const attach = screen.getByTestId('chat-composer-attach');
    const chips = screen.getByTestId('chat-composer-chips');
    expect(chips.contains(attach)).toBe(false);
  });

  it('keeps the attach button reachable when nothing is attached yet', () => {
    render(<ChatComposer {...BASICS} />);

    expect(screen.getByTestId('chat-composer-attach')).toBeInTheDocument();
  });
});

describe('the row of controls under the box', () => {
  it('holds only attach and send', () => {
    render(<ChatComposer {...BASICS} />);

    expect(screen.queryByTestId('chat-composer-select-mode')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-composer-skill')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-composer-attach')).toBeInTheDocument();
    expect(screen.getByTestId('chat-composer-send')).toBeInTheDocument();
  });
});

describe('the box the reader types in', () => {
  it('starts one line tall', () => {
    render(<ChatComposer {...BASICS} />);

    const box = screen.getByTestId('chat-composer-textarea');
    expect(box.querySelectorAll('p')).toHaveLength(1);
    expect(box.className).not.toMatch(/min-h-/);
  });

  it('grows with what is typed, and scrolls in the panel rather than in itself', () => {
    render(<ChatComposer {...BASICS} />);

    const box = screen.getByTestId('chat-composer-textarea');
    // The box takes the height of its content; the ceiling belongs to the
    // wrapper, whose scrollbar is the panel's own rather than the browser's.
    expect(box.className).not.toMatch(/overflow-(y-)?(auto|scroll)|max-h-/);
    // Radix marks its own viewport, which only exists inside a ScrollArea.
    expect(box.closest('[data-radix-scroll-area-viewport]')).not.toBeNull();
  });

  it('leaves the scroll position alone when what is written changes', () => {
    const { rerender } = render(<ChatComposer {...BASICS} draft='one line' />);

    const box = screen.getByTestId('chat-composer-textarea');
    const viewport = box.closest('[data-radix-scroll-area-viewport]');
    if (viewport === null) throw new Error('the composer has no scrolling viewport');

    // Stand in for a scroller that has been scrolled down: nothing about
    // writing more may move the reader off the line they were on.
    const written: number[] = [];
    let held = 120;
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => held,
      set: (next: number) => {
        written.push(next);
        held = next;
      },
    });

    rerender(<ChatComposer {...BASICS} draft={'one line\ntwo lines\nthree'} />);

    expect(written.every((top) => top === 120)).toBe(true);
    expect(box.querySelectorAll('p')).toHaveLength(3);
  });
});

describe('what is said about an attempt to attach', () => {
  it('sits between the attach button and send, marked by a warning icon', () => {
    render(<ChatComposer {...BASICS} attachNotice='At most 10 items' />);

    const notice = screen.getByTestId('chat-composer-attach-notice');
    const attach = screen.getByTestId('chat-composer-attach');
    expect(attach.parentElement?.contains(notice)).toBe(true);
    // The words read in the body colour: warning orange on this surface
    // does not reach 4.5:1 at 12px. The icon carries the warning.
    expect(notice.className).toContain('text-foreground');
    expect(notice.className).not.toContain('text-status-warning-foreground');
    const icon = notice.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-status-warning-foreground');
  });

  it('gives the attach button no hover title', () => {
    render(<ChatComposer {...BASICS} />);

    expect(screen.getByTestId('chat-composer-attach')).not.toHaveAttribute('title');
  });
});

describe('a piece of the canvas above the box', () => {
  it('is counted when several nodes went in unnamed', () => {
    const piece: TrayItem = {
      id: 'canvas-3-x',
      name: '',
      type: 'canvas',
      status: 'ready',
      chip: {
        id: 'canvas-3-x',
        type: 'canvas',
        name: '',
        data_snapshot: { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [] },
      },
    };
    render(<ChatComposer {...BASICS} attachments={[piece]} />);

    expect(screen.getByTestId('chat-chip-canvas-3-x')).toHaveTextContent('3 nodes');
  });
});
