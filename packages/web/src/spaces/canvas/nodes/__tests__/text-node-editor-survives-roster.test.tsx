// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A roster update must not tear down an open text-node editor.
 *
 * `useEditor` compares its dependency list by identity and, on any mismatch,
 * destroys the editor and builds a new one. That is exactly what must not
 * happen while somebody is typing: the rebuild discards the selection and the
 * undo stack, drops IME composition mid-character, and `autofocus: 'end'`
 * then throws the caret to the end of the node.
 *
 * The trap #1882 walked into: the roster bundle handed down from the project
 * page is a NEW OBJECT on every render (the roster array is rebuilt by a
 * `.map()` in the hook body), so listing the bundle itself as a dependency
 * rebuilds the editor whenever anything re-renders the project page —
 * including a collaborator joining, which this very change made a re-render
 * trigger. Only the resolver inside it is reference-stable, and only the
 * resolver is what the extensions consume.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import * as Y from 'yjs';

import type { Member } from '@web/data/api/members';
import {
  useCollaboratorNamesFrom,
  useResolverRef,
} from '@web/features/collab-editor/use-collaborator-names';
import { TextNodeEditor } from '@web/spaces/canvas/nodes/TextNodeEditor';

/** A roster row. */
function member(userId: string, name: string): Member {
  return { id: userId, userId, name, email: `${userId}@x.com`, role: 'editor' };
}

/**
 * Hoisted because it is a dependency of the editor too, and `useCaretUser`
 * memoises it in the app. Rebuilding it per render here would tear the editor
 * down for a reason that has nothing to do with what this file is testing.
 */
const CARET_USER = { id: 'me' };

describe('an open text-node editor', () => {
  let fragment: Y.XmlFragment;

  beforeEach(() => {
    const doc = new Y.Doc();
    fragment = doc.getXmlFragment('body');
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('being typed into')]);
    fragment.insert(0, [para]);
  });

  /** The live editor's DOM node — a rebuild replaces it with a new element. */
  const editorEl = (): Element | null => document.querySelector('.ProseMirror');

  it('survives a roster update that changes the bundle identity', () => {
    // Go through the real hook rather than a hand-built bundle: the bug is
    // about which part of what the project page produces is stable, so a
    // stand-in would be testing a shape nothing actually emits.
    function Harness({ members }: { members: Member[] }): React.JSX.Element {
      const collaboratorNames = useCollaboratorNamesFrom(members);
      return (
        <TextNodeEditor
          fragment={fragment}
          caretProvider={null}
          caretUser={CARET_USER}
          collaboratorNames={collaboratorNames}
          placeholder='p'
          editable
          onLeave={vi.fn()}
        />
      );
    }

    const { rerender } = render(<Harness members={[member('u1', 'Alice')]} />);
    const before = editorEl();
    expect(before).not.toBeNull();

    // A fresh array of the same people — what the roster hook emits on any
    // re-render before this fix, and what any parent re-render can still emit.
    rerender(<Harness members={[member('u1', 'Alice')]} />);
    expect(editorEl()).toBe(before);

    // Somebody actually joined. The resolver reads the roster through a ref,
    // so the new name reaches the carets without the editor being rebuilt.
    rerender(
      <Harness members={[member('u1', 'Alice'), member('u2', 'Bo')]} />,
    );
    expect(editorEl()).toBe(before);
  });

  it('the resolver handed to the extensions stays one reference across roster changes', () => {
    // The other half of the same invariant, at the source: whatever the editor
    // captured at construction has to keep seeing later rosters.
    const seen: Array<(id: string) => string | null> = [];
    function Probe({ members }: { members: Member[] }): null {
      seen.push(useResolverRef(members));
      return null;
    }
    const { rerender } = render(<Probe members={[member('u1', 'Alice')]} />);
    rerender(<Probe members={[member('u1', 'Alice'), member('u2', 'Bo')]} />);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[0]?.('u2')).toBe('Bo');
  });
});
