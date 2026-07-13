// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import * as React from 'react';

import {
  ReferenceMentionList,
  type ReferenceMentionListRef,
} from '@web/spaces/canvas/generate/reference-mention-list';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

const row = (id: string): ReferenceRailItem => ({
  refId: `${id}->me`,
  sourceNodeId: id,
  sourceNodeType: 'image',
  sourceNodeName: id.toUpperCase(),
  thumbnail: `${id}.png`,
});

/**
 * Sends a keydown through the list's imperative handle.
 * @param ref - The list ref.
 * @param key - The KeyboardEvent key.
 */
function sendKey(
  ref: React.RefObject<ReferenceMentionListRef | null>,
  key: string,
): void {
  act(() => {
    ref.current?.onKeyDown(new KeyboardEvent('keydown', { key }));
  });
}

/**
 * Reads which option currently carries the keyboard highlight.
 * @returns The highlighted option's source node id, or null.
 */
function highlighted(): string | null {
  const active = document.querySelector('.bg-accent[data-testid]');
  return (
    active?.getAttribute('data-testid')?.replace('reference-mention-option-', '') ??
    null
  );
}

// Adversarial (batch-2 round-1): @tiptap/suggestion re-runs items() — a FRESH
// array every time — whenever the suggestion range MOVES, and a collaborator
// typing anywhere before the @ in the shared prompt moves it. Resetting the
// highlight on array IDENTITY made that remote keystroke silently snap the
// selection back to row 0, so Enter inserted the WRONG reference. The reset
// must key on CONTENT.
describe('ReferenceMentionList — keyboard highlight vs re-rendered pools', () => {
  it('keeps the highlight when a new-identity array carries the same rows (remote prompt edit)', () => {
    const ref = React.createRef<ReferenceMentionListRef>();
    const { rerender } = render(
      <ReferenceMentionList
        ref={ref}
        items={[row('a'), row('b'), row('c')]}
        command={vi.fn()}
        emptyLabel='none'
      />,
    );
    sendKey(ref, 'ArrowDown');
    sendKey(ref, 'ArrowDown');
    expect(highlighted()).toBe('c');
    // Same content, fresh array identity — exactly what suggestion onUpdate
    // hands over after a remote edit shifts the range.
    rerender(
      <ReferenceMentionList
        ref={ref}
        items={[row('a'), row('b'), row('c')]}
        command={vi.fn()}
        emptyLabel='none'
      />,
    );
    expect(highlighted()).toBe('c');
  });

  it('Enter after a same-content re-render picks the highlighted row, not row 0', () => {
    const ref = React.createRef<ReferenceMentionListRef>();
    const command = vi.fn();
    const { rerender } = render(
      <ReferenceMentionList
        ref={ref}
        items={[row('a'), row('b'), row('c')]}
        command={command}
        emptyLabel='none'
      />,
    );
    sendKey(ref, 'ArrowDown');
    rerender(
      <ReferenceMentionList
        ref={ref}
        items={[row('a'), row('b'), row('c')]}
        command={command}
        emptyLabel='none'
      />,
    );
    sendKey(ref, 'Enter');
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0][0].sourceNodeId).toBe('b');
  });

  it('resets the highlight when the row CONTENT changes (typed query narrowed the pool)', () => {
    const ref = React.createRef<ReferenceMentionListRef>();
    const { rerender } = render(
      <ReferenceMentionList
        ref={ref}
        items={[row('a'), row('b'), row('c')]}
        command={vi.fn()}
        emptyLabel='none'
      />,
    );
    sendKey(ref, 'ArrowDown');
    sendKey(ref, 'ArrowDown');
    rerender(
      <ReferenceMentionList
        ref={ref}
        items={[row('a'), row('c')]}
        command={vi.fn()}
        emptyLabel='none'
      />,
    );
    expect(highlighted()).toBe('a');
  });
});

// I1 (batch-5, user 2026-07-12): arrow-key navigation moved the highlight but
// never scrolled it into view, so selecting past the visible rows left the
// chosen row off-screen (the list scrolls with the mouse but not the keyboard).
// The selected row must scroll into view on every keyboard move.
describe('ReferenceMentionList — keyboard selection scrolls into view', () => {
  it('scrolls the newly-selected row into view on ArrowDown', () => {
    const original = HTMLElement.prototype.scrollIntoView;
    const scrolled: Element[] = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {
      scrolled.push(this as Element);
    };
    try {
      const ref = React.createRef<ReferenceMentionListRef>();
      const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(row);
      render(
        <ReferenceMentionList
          ref={ref}
          items={items}
          command={vi.fn()}
          emptyLabel='none'
        />,
      );
      scrolled.length = 0; // ignore the mount-time scroll of row 0
      sendKey(ref, 'ArrowDown'); // → row 1 (b)
      sendKey(ref, 'ArrowDown'); // → row 2 (c)
      const last = scrolled[scrolled.length - 1];
      expect(last?.getAttribute('data-testid')).toBe(
        'reference-mention-option-c',
      );
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});

// P4 (batch-3, user 2026-07-12): a source with no thumbnail (text / audio / …)
// showed a blanket ImageOff broken-image glyph in the @-picker, inconsistent
// with the prompt chip, which already reads its modality icon via getNodeIcon.
// The picker must show the same per-modality icon so a text node reads as text.
describe('ReferenceMentionList — no-thumbnail modality icon', () => {
  const noThumb = (
    id: string,
    sourceNodeType: ReferenceRailItem['sourceNodeType'],
  ): ReferenceRailItem => ({
    refId: `${id}->me`,
    sourceNodeId: id,
    sourceNodeType,
    sourceNodeName: id.toUpperCase(),
  });

  it('shows the text modality icon (not the broken-image glyph) for a text source', () => {
    const { container } = render(
      <ReferenceMentionList
        items={[noThumb('t', 'text')]}
        command={vi.fn()}
        emptyLabel='none'
      />,
    );
    expect(container.querySelector('.lucide-file-text')).not.toBeNull();
    expect(container.querySelector('.lucide-image-off')).toBeNull();
  });

  it('shows the audio modality icon for an audio source with no thumbnail', () => {
    const { container } = render(
      <ReferenceMentionList
        items={[noThumb('a', 'audio')]}
        command={vi.fn()}
        emptyLabel='none'
      />,
    );
    expect(container.querySelector('.lucide-music')).not.toBeNull();
  });
});
