// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The outlet has to hand the roster down to whichever space body it renders.
 *
 * That single prop is the entire wiring between "this client knows everyone's
 * name" and "carets show names" — every editor gets its resolver through it.
 * Drop it and nothing fails: types still check (the prop is optional), lint is
 * clean, and the whole suite passes while every collaborator's caret renders
 * as an anonymous coloured line. That is what this file exists to prevent, so
 * it asserts on what the body actually RECEIVES rather than on anything the
 * body chooses to render.
 *
 * The registry is mocked here, and only here: the sibling file renders the
 * real space bodies and must keep doing so.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import * as React from 'react';

import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';

/** Props every space body receives, captured per render. */
const received: Array<Record<string, unknown>> = [];

vi.mock('@web/spaces', () => ({
  SPACE_TYPES: {
    canvas: {
      bodyComponent: (props: Record<string, unknown>): React.JSX.Element => {
        received.push(props);
        return <div data-testid='probe-body' />;
      },
    },
  },
}));

const { SpaceOutlet } = await import('@web/pages/project/SpaceOutlet');

const roster: CollaboratorNames = {
  resolve: (userId: string) => (userId === 'u1' ? 'Alice' : null),
  members: [],
};

describe('SpaceOutlet', () => {
  beforeEach(() => {
    received.length = 0;
  });

  it('hands the roster to the space body', () => {
    render(
      <SpaceOutlet
        projectId='p'
        spaceId='s'
        type='canvas'
        collaboratorNames={roster}
      />,
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.collaboratorNames).toBe(roster);
  });

  it('passes the resolver itself through, still able to resolve', () => {
    // Identity is not enough on its own: a future "fix" that rebuilt the
    // bundle on the way down would keep this prop present and non-null while
    // destroying the reference stability the editors depend on.
    render(
      <SpaceOutlet
        projectId='p'
        spaceId='s'
        type='canvas'
        collaboratorNames={roster}
      />,
    );
    const passed = received[0]?.collaboratorNames as CollaboratorNames;
    expect(passed.resolve).toBe(roster.resolve);
    expect(passed.resolve('u1')).toBe('Alice');
  });

  it('passes nothing down when there is no roster yet', () => {
    render(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    expect(received[0]?.collaboratorNames).toBeUndefined();
  });
});
