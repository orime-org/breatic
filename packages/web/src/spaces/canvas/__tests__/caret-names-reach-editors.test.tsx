// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A collaborator's name reaches their caret, end to end, with nothing faked
 * in between.
 *
 * Every other test around this feature stops at a seam: one asserts what the
 * project page hands to the provider, another drives the presence hook with a
 * hand-built roster, a third only checks that an editor was not rebuilt. Each
 * proves its own side, and four rounds of adversarial review kept finding the
 * same thing — a link between two of those sides cut with the whole suite
 * green, because no test ever crossed one.
 *
 * So this crosses all of them at once: a real roster bundle, a real provider,
 * a real editor with real extensions, a real awareness peer. The only thing
 * standing in for anything is the peer itself, which has to be, since the
 * point is that a SECOND client is present.
 *
 * Both canvas editors are covered. They reach the caret builder by their own
 * copy of the same two hops — component reads context, component hands the
 * resolver to the extension builder — and neither hop can be removed, since
 * the builder is a plain function and cannot read context itself. Untested,
 * either was severable in silence.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { TooltipProvider } from '@web/components/ui/tooltip';
import type { Member } from '@web/data/api/members';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import { useCollaboratorNamesFrom } from '@web/features/collab-editor/use-collaborator-names';
import { PromptEditor } from '@web/spaces/canvas/generate/PromptEditor';
import { TextNodeEditor } from '@web/spaces/canvas/nodes/TextNodeEditor';

const REMOTE_CLIENT = 4242;
const ROSTER: Member[] = [
  {
    id: 'u-them',
    userId: 'u-them',
    name: 'Grace',
    email: 'g@example.com',
    role: 'editor',
  },
];

/** This user's caret identity, hoisted so it does not churn per render. */

/** The canvas editors that put collaborator names on carets. */
const EDITORS = [
  {
    name: 'text node',
    render: (
      fragment: Y.XmlFragment,
      caretProvider: { awareness: Awareness },
    ): React.JSX.Element => (
      <TextNodeEditor
        fragment={fragment}
        caretProvider={caretProvider}
        placeholder='p'
        editable
        onLeave={vi.fn()}
      />
    ),
  },
  {
    name: 'generate prompt',
    render: (
      fragment: Y.XmlFragment,
      caretProvider: { awareness: Awareness },
    ): React.JSX.Element => (
      <PromptEditor
        fragment={fragment}
        caretProvider={caretProvider}
        placeholder='p'
        mentionEmptyLabel='none'
        imageRefsDisabled
        references={[]}
        onTextChange={vi.fn()}
        onAtMentionsChange={vi.fn()}
      />
    ),
  },
];

describe.each(EDITORS)('a caret in the $name editor', ({ render: renderEditor }) => {
  let doc: Y.Doc;
  let fragment: Y.XmlFragment;
  let awareness: Awareness;
  /**
   * Stable across renders, like the real thing: the canvas context memoises
   * it, and it is a dependency of the editors — a fresh object per render
   * would rebuild them for a reason that has nothing to do with the roster.
   */
  let caretProvider: { awareness: Awareness };

  beforeEach(() => {
    doc = new Y.Doc();
    fragment = doc.getXmlFragment('body');
    // The cursor plugin bails on an empty mapping, so the document needs
    // content before it can host a caret at all.
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('shared text')]);
    fragment.insert(0, [para]);
    awareness = new Awareness(doc);
    caretProvider = { awareness };
  });

  /** The page around the editor, re-renderable with a different roster. */
  function Page({ members }: { members: readonly Member[] }): React.JSX.Element {
    const collaboratorNames = useCollaboratorNamesFrom(members);
    return (
      <TooltipProvider>
        <CollaboratorNamesProvider value={collaboratorNames}>
          {renderEditor(fragment, caretProvider)}
        </CollaboratorNamesProvider>
      </TooltipProvider>
    );
  }

  /** Mount the editor under a roster the project page would have published. */
  function mount(members: readonly Member[]): { rerender: (m: readonly Member[]) => void } {
    const view = render(<Page members={members} />);
    return { rerender: (m) => view.rerender(<Page members={m} />) };
  }

  /** Put a peer's cursor in the document, the way a real client would. */
  function peerArrives(): void {
    act(() => {
      const at = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(fragment, 0),
      );
      (awareness.states as Map<number, unknown>).set(REMOTE_CLIENT, {
        user: { id: 'u-them' },
        cursor: { anchor: at, head: at },
      });
      awareness.emit('change', [
        { added: [REMOTE_CLIENT], updated: [], removed: [] },
        'remote',
      ]);
    });
  }

  /** The text on the painted caret's label, or null when it has none. */
  const caretLabel = (): string | null => {
    const label = document.querySelector('.collaboration-carets__label');
    return label ? (label.textContent?.trim() ?? '') : null;
  };

  it('shows the name the roster gives for that user id', async () => {
    mount(ROSTER);
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );

    peerArrives();

    await waitFor(() => expect(caretLabel()).toBe('Grace'));
  });

  it('shows a bare caret when the roster does not know that user', async () => {
    // Not a failure state: the roster is fetched, so a peer can genuinely
    // arrive before their name does. A label with nothing in it would be a
    // coloured box saying nothing.
    mount([]);
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );

    peerArrives();

    await waitFor(() =>
      expect(
        document.querySelector('.collaboration-carets__caret'),
      ).not.toBeNull(),
    );
    expect(caretLabel()).toBeNull();
  });

  it('picks up the name when the roster lands after the caret is drawn', async () => {
    // The case the whole redesign exists for. The roster is FETCHED, so a peer
    // routinely turns up before their name does — and a caret that is not
    // moving is never rebuilt, so nothing re-runs the builder that would have
    // named it. Something has to notice and patch the caret already on screen.
    const { rerender } = mount([]);
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );

    peerArrives();
    await waitFor(() =>
      expect(
        document.querySelector('.collaboration-carets__caret'),
      ).not.toBeNull(),
    );
    expect(caretLabel()).toBeNull();

    rerender(ROSTER);

    await waitFor(() => expect(caretLabel()).toBe('Grace'));
  });

  it('follows a rename on a caret that never moves', async () => {
    // Nothing about a name is on the wire, so a rename produces no awareness
    // traffic at all. The only thing that can update this caret is the roster
    // changing underneath it.
    const { rerender } = mount(ROSTER);
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );

    peerArrives();
    await waitFor(() => expect(caretLabel()).toBe('Grace'));

    rerender([{ ...ROSTER[0]!, name: 'Grace Hopper' }]);

    await waitFor(() => expect(caretLabel()).toBe('Grace Hopper'));
  });
});
