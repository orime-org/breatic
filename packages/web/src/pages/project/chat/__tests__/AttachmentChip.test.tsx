// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatAttachedChip } from '@breatic/shared';
import { AttachmentChip } from '@web/pages/project/chat/AttachmentChip';
import { PREVIEW_ROWS } from '@web/pages/project/chat/attachment-preview';
import { HOVER_OPEN_DELAY_MS } from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Hovers the card long enough for its preview to open.
 * @param card - The card element.
 */
function hover(card: HTMLElement): void {
  fireEvent.pointerEnter(card, { pointerType: 'mouse' });
  act(() => {
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10);
  });
}

const canvasChip = (count: number): ChatAttachedChip => ({
  id: 'c',
  type: 'canvas',
  name: '',
  data_snapshot: {
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      type: i === 0 ? 'image' : 'text',
      position: { x: 0, y: 0 },
      data: { kind: i === 0 ? 'image' : 'text', name: `Node ${i}`, content: i === 0 ? 'https://a/i.png' : 'words' },
    })),
    edges: [],
  },
});

describe('AttachmentChip hover preview', () => {
  it('shows an uploaded image when the card is hovered', () => {
    vi.useFakeTimers();
    const chip: ChatAttachedChip = { id: 'f', type: 'image', name: 'a.png', data_snapshot: { url: 'https://a/i.png' } };
    render(<AttachmentChip id='f' type='image' name='a.png' chip={chip} testId='card' />);
    hover(screen.getByTestId('card'));
    const content = screen.getByTestId('hover-preview-content');
    expect(content.querySelector('img')?.getAttribute('src')).toBe('https://a/i.png');
  });

  it('lists the nodes of a canvas card, with a still where there is one, and counts the rest', () => {
    vi.useFakeTimers();
    const chip = canvasChip(PREVIEW_ROWS + 2);
    render(<AttachmentChip id='c' type='canvas' name='' chip={chip} testId='card' />);
    hover(screen.getByTestId('card'));
    const rows = screen.getAllByTestId('attachment-preview-row');
    expect(rows).toHaveLength(PREVIEW_ROWS);
    expect(rows[0]?.textContent).toBe('Node 0');
    expect(rows[0]?.querySelector('img')?.getAttribute('src')).toBe('https://a/i.png');
    expect(rows[1]?.querySelector('img')).toBeNull();
    expect(rows[1]?.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('attachment-preview-more').textContent).toContain('2');
  });

  it('counts the nodes of an unnamed canvas card from what it carries', () => {
    render(<AttachmentChip id='c' type='canvas' name='' chip={canvasChip(3)} testId='card' />);
    expect(screen.getByTestId('card').textContent).toContain('3');
  });

  it('opens nothing for a card that has no address yet', () => {
    vi.useFakeTimers();
    render(<AttachmentChip id='f' type='image' name='a.png' status='uploading' testId='card' />);
    hover(screen.getByTestId('card'));
    expect(screen.queryByTestId('hover-preview-content')).not.toBeInTheDocument();
  });

  it('keeps the same card, and focus on its remove button, when its upload finishes', () => {
    const chip: ChatAttachedChip = { id: 'f', type: 'image', name: 'a.png', data_snapshot: { url: 'https://a/i.png' } };
    const view = (ready: boolean): React.JSX.Element => (
      <AttachmentChip
        id='f'
        type='image'
        name='a.png'
        status={ready ? 'ready' : 'uploading'}
        chip={ready ? chip : undefined}
        onRemove={() => undefined}
        testId='card'
      />
    );
    const { rerender } = render(view(false));
    const button = screen.getByRole('button');
    button.focus();
    rerender(view(true));
    expect(screen.getByRole('button')).toBe(button);
    expect(document.activeElement).toBe(button);
  });
});
