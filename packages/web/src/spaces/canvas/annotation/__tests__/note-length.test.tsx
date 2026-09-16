// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How much a person may write on one note (user 2026-09-16: 300 characters).
 *
 * A note is a landmark on the board, and the thing that decides how big it
 * gets is what somebody types into it. `caps.ts` already bounds how tall each
 * part may draw; this bounds what goes in, so the two agree instead of one
 * silently scrolling what the other never should have accepted.
 *
 * The cap is the platform's own: `maxLength` on the box refuses the 301st
 * character as it is typed or pasted. What is asserted here is that the two
 * boxes that open on demand carry it — the third, the reply box, needs a
 * whole canvas around it and is asserted in `AnnotationSticky.test.tsx`.
 * jsdom's `fireEvent.change` writes the value straight past the attribute, so
 * a test that typed would be testing jsdom; the refusal itself is measured on
 * a real browser in the smoke spec.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AnnotationComposer } from '@web/spaces/canvas/annotation/AnnotationComposer';
import { AnnotationEntry } from '@web/spaces/canvas/annotation/AnnotationEntry';
import { NOTE_MAX_CHARS } from '@web/spaces/canvas/annotation/caps';

describe('what a note will hold', () => {
  it('is 300 characters, the number that was chosen', () => {
    expect(NOTE_MAX_CHARS).toBe(300);
  });

  it('refuses the 301st character in the box a note is placed with', () => {
    render(<AnnotationComposer onCommit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('annotation-composer-input')).toHaveAttribute(
      'maxlength',
      String(NOTE_MAX_CHARS),
    );
  });

  it('refuses it in the box a note is rewritten in', () => {
    render(
      <AnnotationEntry
        content='a cooler grade'
        createdAt={1_757_000_000_000}
        authorName='Zhou'
        rights={{ canEdit: true, canDelete: true }}
        editing='a cooler grade'
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDraft={vi.fn()}
        testId='entry'
      />,
    );
    expect(screen.getByTestId('entry-input')).toHaveAttribute(
      'maxlength',
      String(NOTE_MAX_CHARS),
    );
  });
});
