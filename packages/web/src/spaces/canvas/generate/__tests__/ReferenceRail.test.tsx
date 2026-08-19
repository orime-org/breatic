// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';

// The rail's chips now use the unified HoverPreview (a Radix HoverCard) — no
// TooltipProvider needed (HoverCard has no shared provider; open/close timing is
// per-instance). The `data-state` assertions read the stamp Radix's
// HoverCardTrigger puts on the wrapped chip button.

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

  it('crop badge is the same colour as the name it prefixes, not muted grey (#1801)', () => {
    render(
      <ReferenceRail
        references={[FOCUS_ROW]}
        onRemove={() => {}}
        onInsert={() => {}}
      />,
    );
    const badge = screen.getByTestId('generate-ref-focus-badge-focus:f1');
    const name = screen.getByText('Hero');
    // The crop glyph reads at the name's full strength (text-foreground), not as
    // a de-emphasised adornment — matching the name span it sits beside. The
    // badge is an <svg> (className is an SVGAnimatedString) — read the attribute.
    const badgeClass = badge.getAttribute('class') ?? '';
    expect(badgeClass).toContain('text-foreground');
    expect(badgeClass).not.toContain('text-muted-foreground');
    expect(name.className).toContain('text-foreground');
  });

  it('focus row order is thumbnail → crop badge → name (user 2026-07-17 #4)', () => {
    render(
      <ReferenceRail
        references={[FOCUS_ROW]}
        onRemove={() => {}}
        onInsert={() => {}}
      />,
    );
    const badge = screen.getByTestId('generate-ref-focus-badge-focus:f1');
    const img = screen.getByAltText('Hero');
    const name = screen.getByText('Hero');
    // DOM order: img precedes badge precedes name.
    expect(
      img.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      badge.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('insert AND remove ACCESSIBLE NAMES carry the row name + crop tag (adversarial r2/r3)', () => {
    // aria-label overrides name-from-content, so an sr-only span INSIDE the
    // button is dead and a bare action label announces every row (and every
    // ✕) identically. The labels are ICU messages (locale owns order and
    // punctuation) carrying the row name, plus the crop tag on focus rows.
    render(
      <ReferenceRail
        references={[REFS[0], FOCUS_ROW]}
        onRemove={() => {}}
        onInsert={() => {}}
      />,
    );
    const label = (id: string): string | null =>
      screen.getByTestId(id).getAttribute('aria-label');
    // Both rows are named 'Hero' — exactly the collision the tag resolves.
    const insertPlain = label('generate-ref-insert-a->me');
    const insertFocus = label('generate-ref-insert-focus:f1');
    expect(insertPlain).toContain('Hero');
    expect(insertFocus).toContain('Hero');
    expect(insertFocus).not.toBe(insertPlain);
    // The destructive ✕ resolves the same collision (r3 MEDIUM).
    const removePlain = label('generate-ref-remove-a->me');
    const removeFocus = label('generate-ref-remove-focus:f1');
    expect(removePlain).toContain('Hero');
    expect(removeFocus).toContain('Hero');
    expect(removeFocus).not.toBe(removePlain);
  });

  it('an EMPTY source name falls back to the localized "Reference" in the labels (r3)', () => {
    // nameOf() → '' is a designed-for state; the chip and the @-list both
    // fall back — the rail labels must not degrade to a dangling separator.
    render(
      <ReferenceRail
        references={[{ ...REFS[0], sourceNodeName: '' }]}
        onRemove={() => {}}
        onInsert={() => {}}
      />,
    );
    const insert = screen
      .getByTestId('generate-ref-insert-a->me')
      .getAttribute('aria-label');
    expect(insert).toContain('Reference');
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
  // CONTENT (not an image). Being wrapped by the HoverCard trigger stamps
  // Radix's data-state on the chip button. A text ref WITH content carries it; a
  // text ref WITHOUT content now also carries it — it shows the empty-state hint
  // instead of nothing (H, user 2026-07-12).
  it('wraps a text reference (with content OR empty) in a hover preview (HoverCard trigger)', () => {
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
      <ReferenceRail
        references={refs}
        onRemove={() => {}}
        onInsert={onInsert}
        // The image panel in image-to-image: it reads the pool, and what it
        // reads from it is images. Stating the mode is what #1945 changed —
        // the verdict did not. It used to come from asking whether the row
        // could connect to an image NODE, which happened to give the right
        // answer on this panel and the wrong one on the video panel, where
        // `audio → video` is a live connection rather than a legacy edge.
        modeTakesReferences
      />,
    );
    const legacyInsert = screen.getByTestId('generate-ref-insert-aud->me');
    expect(legacyInsert).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(legacyInsert);
    expect(onInsert).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('generate-ref-remove-aud->me'),
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByTestId('generate-ref-insert-img->me'),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  // Text-to-image reads no source images at all (round-3 R3-4, user ruled A
  // 2026-07-11) — that part is unchanged. What #1945 changed is the SCOPE of
  // the dim. It used to be applied per row by modality, reaching image rows
  // only, which is how audio and video rows stayed bright and removable in a
  // mode that would never read them (#1930, #1940). The dim now covers every
  // REFERENCE MATERIAL row rather than the image one alone; #1952 then moved it
  // off the row wrapper onto the row's CONTENT button, so the ✕ beside it never
  // inherits it and removal works in every state. A text row is prompt material
  // and outside the rule.
  //
  // The rule's subject is the REFERENCE MATERIAL: a text row substitutes into
  // the prompt STRING, so it is outside this rule entirely — lit, insertable
  // and removable whatever the mode does with references. (Whether the active
  // model takes a prompt at all is a different question; the rail asks it
  // itself since #1966, off the `modelTakesPrompt` prop. It used to be the
  // video container's, and that second home is what #1962 removed.) The full
  // 24-combination matrix and the refusal messages live in
  // `ReferenceRail-states.test.tsx`; this one keeps the t2i case anchored
  // where the rest of the rail's rendering is pinned.
  it('dims the reference-material rows when the mode takes no references', () => {
    render(
      <ReferenceRail
        references={REFS}
        onRemove={() => {}}
        onInsert={() => {}}
        modeTakesReferences={false}
      />,
    );
    // Both rows still render — the edges stay visible, they just cannot act.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // The dim is on each row's CONTENT button (#1952) — not on the rail
    // container, not on the row wrapper, and not on the ✕: one opacity, so a
    // dark row's controls cannot end up at 0.25, and the ✕ stays usable.
    expect(screen.getByTestId('generate-reference-rail')).not.toHaveClass(
      'opacity-50',
    );
    expect(screen.getByTestId('generate-ref-a->me')).not.toHaveClass(
      'opacity-50',
    );
    expect(screen.getByTestId('generate-ref-insert-a->me')).toHaveClass(
      'opacity-50',
    );
    // The text row is prompt material and stays lit — the dim rule's subject
    // is the reference material (user 2026-08-13, second clarification).
    expect(screen.getByTestId('generate-ref-insert-b->me')).not.toHaveClass(
      'opacity-50',
    );
    // Image row: refuses INSERT only. Its ✕ stays live like every other one
    // (#1952, user 2026-08-19) — the two halves of a row are decoupled.
    expect(screen.getByTestId('generate-ref-insert-a->me')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      screen.getByTestId('generate-ref-remove-a->me'),
    ).not.toHaveAttribute('aria-disabled', 'true');
    // The text row's ✕ stays live too — every ✕ does now.
    expect(screen.getByTestId('generate-ref-remove-b->me')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // Text row still inserts — the dim rule is about reference material.
    expect(screen.getByTestId('generate-ref-insert-b->me')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
