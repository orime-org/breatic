// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';

const REFS: ReferenceRailItem[] = [
  {
    refId: 'a->me',
    sourceNodeId: 'a',
    sourceNodeType: 'image',
    sourceNodeName: 'Hero',
    thumbnail: 'https://cdn/hero.png',
  },
  {
    refId: 'b->me',
    sourceNodeId: 'b',
    sourceNodeType: 'text',
    sourceNodeName: 'Notes',
  },
];

describe('ReferenceRail — renders the derived reference rows with a remove control', () => {
  it('renders one row per reference with its source name', () => {
    render(
      <ReferenceRail references={REFS} onRemove={() => {}} onInsert={() => {}} />,
    );
    expect(screen.getByText('Hero')).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('fires onRemove with the reference id when its ✕ is clicked', () => {
    const onRemove = vi.fn();
    render(
      <ReferenceRail references={REFS} onRemove={onRemove} onInsert={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('generate-ref-remove-b->me'));
    expect(onRemove).toHaveBeenCalledWith('b->me');
  });

  it('fires onInsert with the reference row when the chip body is clicked', () => {
    const onInsert = vi.fn();
    render(
      <ReferenceRail references={REFS} onRemove={() => {}} onInsert={onInsert} />,
    );
    fireEvent.click(screen.getByTestId('generate-ref-insert-b->me'));
    expect(onInsert).toHaveBeenCalledWith(REFS[1]);
  });

  it('renders nothing when there are no references', () => {
    const { container } = render(
      <ReferenceRail references={[]} onRemove={() => {}} onInsert={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Text-reference hover (spec §9.1): hovering a text reference previews its
  // CONTENT (not an image). Being wrapped by the Tooltip trigger stamps
  // Radix's data-state on the chip button — a text ref with content carries
  // it; a text ref without content (nothing to preview) stays unwrapped.
  it('wraps a text reference with content in a hover preview (Tooltip trigger)', () => {
    const refs: ReferenceRailItem[] = [
      {
        refId: 'txt->me',
        sourceNodeId: 'txt',
        sourceNodeType: 'text',
        sourceNodeName: 'Notes',
        textContent: 'a red panda on a bike',
      },
      {
        refId: 'empty->me',
        sourceNodeId: 'empty',
        sourceNodeType: 'text',
        sourceNodeName: 'Empty',
      },
    ];
    render(
      <ReferenceRail references={refs} onRemove={() => {}} onInsert={() => {}} />,
    );
    expect(screen.getByTestId('generate-ref-insert-txt->me')).toHaveAttribute(
      'data-state',
    );
    expect(
      screen.getByTestId('generate-ref-insert-empty->me'),
    ).not.toHaveAttribute('data-state');
  });

  it('greys out + de-activates the rail when disabled (text-to-image, §2.5)', () => {
    render(
      <ReferenceRail
        references={REFS}
        onRemove={() => {}}
        onInsert={() => {}}
        disabled
      />,
    );
    const rail = screen.getByTestId('generate-reference-rail');
    // Still renders the chips (edges stay visible) but dimmed + non-interactive:
    // the remove buttons are disabled (blocks mouse AND keyboard).
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(rail).toHaveClass('opacity-50');
    expect(screen.getByTestId('generate-ref-remove-a->me')).toBeDisabled();
    expect(screen.getByTestId('generate-ref-insert-a->me')).toBeDisabled();
  });
});
