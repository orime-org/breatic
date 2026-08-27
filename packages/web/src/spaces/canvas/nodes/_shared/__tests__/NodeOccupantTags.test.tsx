// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';
import { NodeOccupantTags } from '@web/spaces/canvas/nodes/_shared/NodeOccupantTags';

/**
 * Build a roster that answers from a plain map.
 * @param names - User id to display name; a missing id resolves to null,
 * which is what `resolveNameFrom` answers for someone it cannot name.
 * @returns The roster bundle the provider publishes.
 */
function roster(names: Record<string, string>): CollaboratorNames {
  return { resolve: (userId: string) => names[userId] ?? null, members: [] };
}

/**
 * Render the tags inside a roster.
 * @param userIds - Who is holding the node.
 * @param names - The roster to resolve them against.
 */
function renderTags(userIds: string[], names: Record<string, string>): void {
  render(
    <CollaboratorNamesProvider value={roster(names)}>
      <NodeOccupantTags userIds={userIds} indentPx={4} />
    </CollaboratorNamesProvider>,
  );
}

describe('NodeOccupantTags', () => {
  it('draws one tag per person', () => {
    renderTags(['u1', 'u2'], { u1: 'Alice', u2: '陈默' });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('陈默')).toBeInTheDocument();
  });

  it('gives each person their own identity colour', () => {
    renderTags(['u1', 'u2'], { u1: 'Alice', u2: 'Bob' });

    const alice = screen.getByText('Alice');
    const bob = screen.getByText('Bob');
    // The hue is derived from the id, so two different ids that happen to hash
    // to the same hue would make this vacuous; these two do not.
    expect(alice.style.backgroundColor).not.toBe('');
    expect(alice.style.backgroundColor).not.toBe(bob.style.backgroundColor);
  });

  it('draws at most two names and counts the rest', () => {
    // The row hangs above a 288px node and each name runs to about a hundred
    // pixels, so the count is what keeps it from growing past the node it
    // belongs to. Same shape as the members stack in the top bar.
    renderTags(['u1', 'u2', 'u3', 'u4'], {
      u1: 'Alice',
      u2: 'Bob',
      u3: 'Carol',
      u4: 'Dan',
    });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Carol')).not.toBeInTheDocument();
    expect(screen.getByTestId('node-occupant-overflow')).toHaveTextContent('+2');
  });

  it('counts only the people it left out', () => {
    renderTags(['u1', 'u2', 'u3'], { u1: 'Alice', u2: 'Bob', u3: 'Carol' });

    // Two drawn plus the one the badge stands for is the whole party of three.
    expect(screen.getByTestId('node-occupant-overflow')).toHaveTextContent('+1');
  });

  it('draws no count when everyone fits', () => {
    renderTags(['u1', 'u2'], { u1: 'Alice', u2: 'Bob' });

    expect(screen.queryByTestId('node-occupant-overflow')).not.toBeInTheDocument();
  });

  it('counts only people it could name', () => {
    // Someone the roster cannot name is not a person the row is hiding — they
    // are nobody as far as this row is concerned, and counting them would
    // promise a name that does not exist.
    renderTags(['u1', 'u2', 'ghost'], { u1: 'Alice', u2: 'Bob' });

    expect(screen.queryByTestId('node-occupant-overflow')).not.toBeInTheDocument();
  });

  it('picks up a name that lands after the holding did', () => {
    // The roster arrives from a query, so the first render of a tag row is
    // routinely one where nobody can be named yet. The resolver's reference
    // is stable for the component's lifetime by design, so keying the lookup
    // on it would freeze these names at that first empty roster — and the row
    // would sit there naming nobody until the node changed hands.
    const { rerender } = render(
      <CollaboratorNamesProvider value={roster({})}>
        <NodeOccupantTags userIds={['u1']} indentPx={4} />
      </CollaboratorNamesProvider>,
    );
    expect(screen.queryByTestId('node-occupant-tags')).not.toBeInTheDocument();

    rerender(
      <CollaboratorNamesProvider value={roster({ u1: 'Alice' })}>
        <NodeOccupantTags userIds={['u1']} indentPx={4} />
      </CollaboratorNamesProvider>,
    );

    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('follows a rename', () => {
    const ids = ['u1'];
    const { rerender } = render(
      <CollaboratorNamesProvider value={roster({ u1: 'Alice' })}>
        <NodeOccupantTags userIds={ids} indentPx={4} />
      </CollaboratorNamesProvider>,
    );

    // The same id list object, so only the roster moved.
    rerender(
      <CollaboratorNamesProvider value={roster({ u1: 'Alicia' })}>
        <NodeOccupantTags userIds={ids} indentPx={4} />
      </CollaboratorNamesProvider>,
    );

    expect(screen.getByText('Alicia')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('leaves out someone the roster cannot name', () => {
    // A member who left the project, or a roster that has not loaded: a
    // coloured chip with no name says nothing about who is there.
    renderTags(['u1', 'ghost'], { u1: 'Alice' });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByTestId('node-occupant-tags').children).toHaveLength(1);
  });

  it('renders nothing when nobody is holding the node', () => {
    renderTags([], { u1: 'Alice' });

    expect(screen.queryByTestId('node-occupant-tags')).not.toBeInTheDocument();
  });

  it('renders nothing when nobody holding it can be named', () => {
    renderTags(['ghost'], {});

    expect(screen.queryByTestId('node-occupant-tags')).not.toBeInTheDocument();
  });

  it('renders nothing without a roster around it', () => {
    // An isolated component test, or any future canvas mounted outside a
    // project, degrades to no tags rather than throwing.
    render(<NodeOccupantTags userIds={['u1']} indentPx={4} />);

    expect(screen.queryByTestId('node-occupant-tags')).not.toBeInTheDocument();
  });

  it('indents the row by the amount its anchor asks for', () => {
    // The two mount points sit above names with different padding: the content
    // node's header has 4px, the group's name has none.
    renderTags(['u1'], { u1: 'Alice' });

    expect(screen.getByTestId('node-occupant-tags')).toHaveStyle({
      paddingLeft: '4px',
    });
  });

  it('takes no pointer events', () => {
    renderTags(['u1'], { u1: 'Alice' });

    expect(screen.getByTestId('node-occupant-tags').className).toContain(
      'pointer-events-none',
    );
  });
});
