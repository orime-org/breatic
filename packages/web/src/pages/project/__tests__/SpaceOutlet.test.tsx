// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SpaceOutlet } from '@web/pages/project/SpaceOutlet';

// Stubbed to expose what it was HANDED, which is the only thing this file can
// answer for. Whether the notice then uses the role correctly is asserted in
// its own tests, against the real component.
//
// The role reaching it is load-bearing and easy to drop silently: the notice
// fires on the server's read-only flag, which is also set for every viewer, so
// an outlet that forgets to pass the role shows every viewer a warning that
// their editing was taken away. That is exactly what shipped in this branch
// before Gate 2 round 4 caught it, and nothing failed at the time.
// EVERY prop it was handed, not just the interesting one: the notice resolves
// a document name out of `projectId`, `spaceId` and `type`, so a stub that drops
// three of the four cannot see the outlet pointing it at the wrong document —
// and pointing it at the wrong document is silent, because the wrong document
// is simply never at its ceiling. Round 5 measured it: with only `readOnly` and
// `type` recorded, swapping `projectId` and `spaceId` left all 310 tests in
// this directory green.
vi.mock('@web/pages/project/SpaceReadOnlyNotice', () => ({
  SpaceReadOnlyNotice: ({
    projectId,
    spaceId,
    type,
    readOnly,
  }: {
    projectId: string;
    spaceId: string;
    type: string;
    readOnly?: boolean;
  }) => (
    <div
      data-testid='notice-stub'
      data-project-id={projectId}
      data-space-id={spaceId}
      data-type={type}
      data-readonly={String(readOnly)}
    />
  ),
}));

describe('SpaceOutlet', () => {
  it('points the notice at THIS Space of THIS project', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='document' />);
    const stub = screen.getByTestId('notice-stub');
    expect(stub).toHaveAttribute('data-project-id', 'p');
    expect(stub).toHaveAttribute('data-space-id', 's');
    // The kind is half the document's identity: a canvas and a document Space
    // that share an id are two documents with two separate ceilings.
    expect(stub).toHaveAttribute('data-type', 'document');
  });

  it('points the body at THIS Space of THIS project', () => {
    // The sibling of the notice assertion above. Round 6 measured that
    // swapping these two on the body was invisible to all 63 tests in this
    // directory — the existing body cases only ask WHICH component rendered.
    // A body pointed at the wrong document silently shows another Space's
    // content, which is worse than the notice being wrong.
    render(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    const body = screen.getByTestId('canvas-space');
    expect(body).toHaveAttribute('data-project-id', 'p');
    expect(body).toHaveAttribute('data-space-id', 's');
  });

  it('hands the viewer role to the read-only notice, not just to the body', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='canvas' readOnly />);
    expect(screen.getByTestId('notice-stub')).toHaveAttribute(
      'data-readonly',
      'true',
    );
  });

  it('tells the notice an editor is an editor', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    // `undefined`, not `false`: the outlet forwards its own optional prop
    // untouched and the notice defaults it. Asserting the string keeps this
    // honest about which side owns the default.
    expect(screen.getByTestId('notice-stub')).toHaveAttribute(
      'data-readonly',
      'undefined',
    );
  });

  it('renders the canvas body for type=canvas', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    expect(screen.getByTestId('canvas-space')).toBeInTheDocument();
  });

  it('renders the document body for type=document', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='document' />);
    expect(screen.getByTestId('document-space')).toBeInTheDocument();
  });

  it('renders the timeline body for type=timeline (empty state)', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='timeline' />);
    expect(screen.getByTestId('timeline-space-empty')).toBeInTheDocument();
  });

  it('forwards readOnly to the space body (viewer gate reaches the canvas)', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='canvas' readOnly />);
    expect(screen.getByTestId('canvas-space')).toHaveAttribute(
      'data-readonly',
      'true',
    );
  });

  it('omits the read-only marker for editors', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    expect(screen.getByTestId('canvas-space')).not.toHaveAttribute(
      'data-readonly',
    );
  });
});
