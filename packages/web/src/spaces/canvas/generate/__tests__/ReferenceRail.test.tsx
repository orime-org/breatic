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

const FOCUS_ROW: ReferenceRailItem = {
  refId: 'focus:f1',
  sourceNodeId: 'focus:f1',
  sourceNodeType: 'image',
  sourceNodeName: 'Hero',
  thumbnail: 'https://cdn/crop.png',
  focus: true,
};

describe('ReferenceRail — focus rows and pending placeholders (#1782)', () => {
  it('renders a crop badge on focus rows only', () => {
    render(
      <ReferenceRail
        references={[...REFS, FOCUS_ROW]}
        onRemove={() => {}}
        onInsert={() => {}}
      />,
    );
    expect(
      screen.getByTestId('generate-ref-focus-badge-focus:f1'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('generate-ref-focus-badge-a->me')).toBeNull();
  });

  it('a focus row ✕ fires onRemove with the ROW (focus flag routes to the crop)', () => {
    const onRemove = vi.fn();
    render(
      <ReferenceRail
        references={[FOCUS_ROW]}
        onRemove={onRemove}
        onInsert={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ref-remove-focus:f1'));
    expect(onRemove).toHaveBeenCalledWith(FOCUS_ROW);
  });

  it('renders pending focus placeholders (dashed, non-interactive) and shows the rail with only them', () => {
    render(
      <ReferenceRail
        references={[]}
        onRemove={() => {}}
        onInsert={() => {}}
        pendingFocus={[{ id: 'tmp1', name: 'Uploading crop' }]}
      />,
    );
    const pending = screen.getByTestId('generate-focus-pending-tmp1');
    expect(pending).toBeInTheDocument();
    expect(screen.getByText('Uploading crop')).toBeInTheDocument();
    // Placeholder carries no insert / remove controls.
    expect(pending.querySelector('button')).toBeNull();
  });
});

describe('ReferenceRail — renders the derived reference rows with a remove control', () => {
  it('renders one row per reference with its source name', () => {
    render(
      <ReferenceRail references={REFS} onRemove={() => {}} onInsert={() => {}} />,
    );
    expect(screen.getByText('Hero')).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('fires onRemove with the ROW when its ✕ is clicked (identity routing, adversarial R2)', () => {
    const onRemove = vi.fn();
    render(
      <ReferenceRail references={REFS} onRemove={onRemove} onInsert={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('generate-ref-remove-b->me'));
    expect(onRemove).toHaveBeenCalledWith(REFS[1]);
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
  // CONTENT (not an image). Being wrapped by the Tooltip trigger stamps Radix's
  // data-state on the chip button. A text ref WITH content carries it; a text
  // ref WITHOUT content now also carries it — it shows the empty-state hint
  // instead of nothing (H, user 2026-07-12).
  it('wraps a text reference (with content OR empty) in a hover preview (Tooltip trigger)', () => {
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
    // Empty source → still wrapped, now showing the empty-state hint (H).
    expect(
      screen.getByTestId('generate-ref-insert-empty->me'),
    ).toHaveAttribute('data-state');
  });

  // Legacy-edge parity with the @ picker (round-2 adversarial): a pre-rules
  // audio/video→image edge stays LISTED so the user can remove it, but its
  // insert button must be disabled — the @ picker already refuses to offer
  // such a reference, and inserting it from the rail would recreate the exact
  // execute-time dead-end the connection rules eliminated.
  it('disables insert (but not remove) for a type-incompatible legacy reference', () => {
    const refs: ReferenceRailItem[] = [
      {
        refId: 'aud->me',
        sourceNodeId: 'aud',
        sourceNodeType: 'audio',
        sourceNodeName: 'Song',
      },
      {
        refId: 'img->me',
        sourceNodeId: 'img',
        sourceNodeType: 'image',
        sourceNodeName: 'Pic',
        thumbnail: 'x.png',
      },
    ];
    const onInsert = vi.fn();
    render(
      <ReferenceRail references={refs} onRemove={() => {}} onInsert={onInsert} />,
    );
    const legacyInsert = screen.getByTestId('generate-ref-insert-aud->me');
    expect(legacyInsert).toBeDisabled();
    fireEvent.click(legacyInsert);
    expect(onInsert).not.toHaveBeenCalled();
    expect(screen.getByTestId('generate-ref-remove-aud->me')).not.toBeDisabled();
    expect(screen.getByTestId('generate-ref-insert-img->me')).not.toBeDisabled();
  });

  // Text-to-image scoping (round-3 R3-4, user ruled A 2026-07-11): t2i only
  // ignores SOURCE IMAGES — text references still serialize into the prompt
  // through their @-chips, so only the image rows go inert. Same口径 as the
  // editor's chip dim, which greys image chips only.
  it('dims + de-activates only the IMAGE rows when imageRefsDisabled (t2i)', () => {
    const onInsert = vi.fn();
    const onRemove = vi.fn();
    render(
      <ReferenceRail
        references={REFS}
        onRemove={onRemove}
        onInsert={onInsert}
        imageRefsDisabled
      />,
    );
    // Both rows still render (edges stay visible); the rail itself is NOT
    // blanket-dimmed — the dim lives on the image row.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('generate-reference-rail')).not.toHaveClass(
      'opacity-50',
    );
    // Image row: dimmed + non-interactive (switch to i2i to manage it).
    expect(screen.getByTestId('generate-ref-a->me')).toHaveClass('opacity-50');
    expect(screen.getByTestId('generate-ref-insert-a->me')).toBeDisabled();
    expect(screen.getByTestId('generate-ref-remove-a->me')).toBeDisabled();
    // Text row: fully interactive — insert lands the @-chip, remove works.
    expect(screen.getByTestId('generate-ref-b->me')).not.toHaveClass(
      'opacity-50',
    );
    const textInsert = screen.getByTestId('generate-ref-insert-b->me');
    expect(textInsert).not.toBeDisabled();
    fireEvent.click(textInsert);
    expect(onInsert).toHaveBeenCalledWith(REFS[1]);
    fireEvent.click(screen.getByTestId('generate-ref-remove-b->me'));
    expect(onRemove).toHaveBeenCalledWith(REFS[1]);
  });
});
