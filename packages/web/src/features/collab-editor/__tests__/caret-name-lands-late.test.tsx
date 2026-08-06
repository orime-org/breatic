// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A name that arrives after the caret is already on screen still reaches it.
 *
 * This is the failure mode that makes the whole redesign work or not. The
 * roster is FETCHED, so a collaborator's caret routinely appears before their
 * name is known — and a caret that is not moving never gets rebuilt:
 * prosemirror-view keys the widget on the client id and reuses its DOM on key
 * equality WITHOUT re-invoking the builder. Asking the cursor plugin to
 * rebuild does not help either; that path only re-runs the builder when the
 * previous decorations were destroyed, which a roster update does not do.
 *
 * The repo already paid for this once: the focus-dim flip was dead in both
 * directions for exactly this reason, and the fix was to patch the existing
 * DOM found by data-client-id. This does the same for names.
 *
 * THE EDITOR IS BUILT ONCE, on purpose. The first version of this file called
 * `fakeEditor(dom)` inside the render function, so the editor was a new object
 * on every render and the effect re-ran off THAT — which meant the roster
 * dependency it was written to protect could be deleted with all four cases
 * still passing. In the app the editor reference is deliberately stable (that
 * was an earlier fix in this same change), so a fresh one per render tested a
 * situation that cannot happen and hid the one that can.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import type { Editor } from '@tiptap/core';
import * as React from 'react';
import * as Y from 'yjs';

import type { Member } from '@web/data/api/members';
import { renderCollabCaret } from '@web/features/collab-editor/caret-render';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import { useCollabCaretPresence } from '@web/features/collab-editor/use-collab-caret-presence';
import { resolveNameFrom } from '@web/features/collab-editor/use-collaborator-names';

/** A roster row. */
function member(userId: string, name: string): Member {
  return { id: userId, userId, name, email: `${userId}@x.com`, role: 'editor' };
}

/** The label text currently painted on a caret, or null when there is none. */
function labelOf(root: HTMLElement, clientId: number): string | null {
  const caret = root.querySelector<HTMLElement>(
    `.collaboration-carets__caret[data-client-id="${clientId}"]`,
  );
  const label = caret?.querySelector('.collaboration-carets__label');
  return label ? (label.textContent ?? '') : null;
}

/**
 * A stand-in editor exposing only what the presence hook touches: the DOM it
 * scans for carets, and the command it publishes focus through.
 */
function fakeEditor(dom: HTMLElement): Editor {
  return {
    isDestroyed: false,
    view: { dom },
    commands: { updateUser: () => true },
  } as unknown as Editor;
}

describe('a caret already on screen when its name arrives', () => {
  let dom: HTMLElement;
  let awareness: Awareness;
  let editor: Editor;
  const REMOTE_CLIENT = 99;

  beforeEach(() => {
    dom = document.createElement('div');
    document.body.replaceChildren(dom);
    awareness = new Awareness(new Y.Doc());
    // The remote peer publishes its id and nothing else, the way #1882 has it.
    awareness.getStates().set(REMOTE_CLIENT, { user: { id: 'u1' } });
    // A caret built while the roster knew nobody: colour line, no label.
    dom.appendChild(renderCollabCaret({ id: 'u1' }, REMOTE_CLIENT, () => null));
    // Built once, like the real thing.
    editor = fakeEditor(dom);
  });

  /** Nothing to render — the hook works by touching the caret DOM directly. */
  function Probe(): null {
    useCollabCaretPresence(editor, { awareness }, { id: 'me' });
    return null;
  }

  /** Wrap the probe in a roster, the way the project page does. */
  function withRoster(members: readonly Member[]): React.JSX.Element {
    return (
      <CollaboratorNamesProvider
        value={{
          resolve: (userId: string) => resolveNameFrom(members, userId),
          members,
        }}
      >
        <Probe />
      </CollaboratorNamesProvider>
    );
  }

  it('gets its label once the roster names that user', () => {
    const { rerender } = render(withRoster([]));
    expect(labelOf(dom, REMOTE_CLIENT)).toBeNull();

    rerender(withRoster([member('u1', 'Alice')]));
    expect(labelOf(dom, REMOTE_CLIENT)).toBe('Alice');
  });

  it('follows a rename without the caret moving', () => {
    const { rerender } = render(withRoster([member('u1', 'Alice')]));
    expect(labelOf(dom, REMOTE_CLIENT)).toBe('Alice');

    rerender(withRoster([member('u1', 'Alice Wu')]));
    expect(labelOf(dom, REMOTE_CLIENT)).toBe('Alice Wu');
  });

  it('drops the label again if the roster stops naming that user', () => {
    // A member removed from the project mid-session. Leaving a stale name on
    // screen would be worse than showing none.
    const { rerender } = render(withRoster([member('u1', 'Alice')]));
    expect(labelOf(dom, REMOTE_CLIENT)).toBe('Alice');

    rerender(withRoster([]));
    expect(labelOf(dom, REMOTE_CLIENT)).toBeNull();
  });

  it('leaves a named caret alone when awareness no longer has an id for it', () => {
    // A peer whose awareness entry is already gone while their caret waits to
    // be swept. Without an id there is nothing to resolve, and treating that
    // as "unresolved" would strip the name off a caret that is still on
    // screen — a visible flicker in exchange for nothing.
    const { rerender } = render(withRoster([member('u1', 'Alice')]));
    expect(labelOf(dom, REMOTE_CLIENT)).toBe('Alice');

    awareness.getStates().delete(REMOTE_CLIENT);
    rerender(withRoster([]));
    expect(labelOf(dom, REMOTE_CLIENT)).toBe('Alice');
  });

  it('resolves nobody outside a provider, rather than throwing', () => {
    // An editor mounted in isolation — a component test, or any future reuse
    // off the project page. Same answer as a roster that has not loaded.
    render(<Probe />);
    expect(labelOf(dom, REMOTE_CLIENT)).toBeNull();
  });
});
