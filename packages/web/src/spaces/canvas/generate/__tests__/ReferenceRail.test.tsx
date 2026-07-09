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
    render(<ReferenceRail references={REFS} onRemove={() => {}} />);
    expect(screen.getByText('Hero')).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('fires onRemove with the reference id when its ✕ is clicked', () => {
    const onRemove = vi.fn();
    render(<ReferenceRail references={REFS} onRemove={onRemove} />);
    fireEvent.click(screen.getByTestId('generate-ref-remove-b->me'));
    expect(onRemove).toHaveBeenCalledWith('b->me');
  });

  it('renders nothing when there are no references', () => {
    const { container } = render(
      <ReferenceRail references={[]} onRemove={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
