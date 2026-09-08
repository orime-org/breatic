// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A22 的在场那半: the shared presence hook, driving a BlockNote
 * editor.
 *
 * `useCollabCaretPresence` is one hook for three editors, and two of them stay
 * on `@tiptap/y-tiptap` for now. It reaches into an editor for two things —
 * publishing this window's focus, and finding the element remote carets are
 * drawn into — and both were spelled in tiptap's vocabulary.
 *
 * The publishing half needs no editor at all. `editor.commands.updateUser` is
 * `awareness.setLocalStateField("user", attributes)` and nothing else
 * (`extension-collaboration-caret/dist/index.js:61-64`); BlockNote's namesake
 * is the same line (`@blocknote/core/dist/yjs.js:132-134`). The hook writes the
 * field itself, which is the same write for every editor.
 *
 * The other half is a DOM lookup, and the two editors keep their view under
 * different names.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { useCollabCaretPresence } from '@web/features/collab-editor/use-collab-caret-presence';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentCaretExtension } from '@web/spaces/document/document-caret';

const REMOTE_CLIENT_ID = 7171;
const BLURRED_CLASS = 'collaboration-carets__caret--blurred';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];
const opened: { awareness: Awareness; doc: Y.Doc }[] = [];
const hooks: { unmount: () => void }[] = [];

afterEach(() => {
  hooks.splice(0).forEach((rendered) => {
    rendered.unmount();
  });
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  opened.splice(0).forEach(({ awareness, doc }) => {
    awareness.destroy();
    doc.destroy();
  });
});

/**
 * Opens a document editor that draws remote carets.
 * @returns The editor, its awareness, and the element it rendered into.
 */
function open(): {
  editor: ReturnType<typeof buildDocumentEditor>;
  awareness: Awareness;
  root: HTMLElement;
  } {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  opened.push({ awareness, doc });

  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [documentCaretExtension(awareness, () => null)],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'something to park a caret in' },
  ] as never);
  return { editor, awareness, root };
}

/**
 * Puts a collaborator's caret into the document, the way the wire delivers it.
 * @param doc - The shared document.
 * @param awareness - The awareness the caret plugin reads.
 * @param focused - What that collaborator's window reports.
 */
async function remoteCaretArrives(
  doc: Y.Doc,
  awareness: Awareness,
  focused: boolean,
): Promise<void> {
  const cursor = Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(documentBodyFragment(doc), 0),
  );
  (awareness.states as Map<number, unknown>).set(REMOTE_CLIENT_ID, {
    user: { id: 'u-them', focused },
    cursor: { anchor: cursor, head: cursor },
  });
  await act(async () => {
    awareness.emit('change', [
      { added: [REMOTE_CLIENT_ID], updated: [], removed: [] },
      'remote',
    ]);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

describe('the presence hook on a BlockNote editor', () => {
  it('publishes this window’s focus, and states nothing else', () => {
    const { editor, awareness } = open();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    const rendered = renderHook(() => {
      useCollabCaretPresence(editor, { awareness });
    });
    hooks.push(rendered);

    expect(awareness.getLocalState()?.['user']).toEqual({ focused: true });

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(awareness.getLocalState()?.['user']).toEqual({ focused: false });

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(awareness.getLocalState()?.['user']).toEqual({ focused: true });
  });

  it('withdraws this client’s caret when the body unmounts', () => {
    const { editor, awareness } = open();
    awareness.setLocalStateField('cursor', { anchor: {}, head: {} });

    const rendered = renderHook(() => {
      useCollabCaretPresence(editor, { awareness });
    });
    rendered.unmount();

    expect(awareness.getLocalState()?.['cursor']).toBeNull();
  });

  it('dims the caret of a collaborator whose window is in the background', async () => {
    const { editor, awareness, root } = open();
    const doc = (opened.at(-1) as { doc: Y.Doc }).doc;

    hooks.push(
      renderHook(() => {
        useCollabCaretPresence(editor, { awareness });
      }),
    );
    await remoteCaretArrives(doc, awareness, false);

    const caret = root.querySelector<HTMLElement>(
      '.collaboration-carets__caret[data-client-id]',
    );
    expect(caret).not.toBeNull();
    expect(caret?.classList.contains(BLURRED_CLASS)).toBe(true);
  });

  it('survives an awareness change after the editor has been unmounted', () => {
    // An ordinary Space-tab switch reaches this: the body unmounts the editor,
    // and the hook's effects belong to a component further up whose cleanup has
    // not run yet. A BlockNote editor answers every question about its view by
    // throwing once unmounted, so an awareness event landing in that window
    // would take the whole listener chain down with it — including whatever
    // the emitter was in the middle of.
    const { editor, awareness } = open();
    const doc = (opened.at(-1) as { doc: Y.Doc }).doc;
    hooks.push(
      renderHook(() => {
        useCollabCaretPresence(editor, { awareness });
      }),
    );

    editor.unmount();
    mounted.length = 0;

    expect(() => {
      const cursor = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(documentBodyFragment(doc), 0),
      );
      (awareness.states as Map<number, unknown>).set(REMOTE_CLIENT_ID, {
        user: { id: 'u-them', focused: false },
        cursor: { anchor: cursor, head: cursor },
      });
      awareness.emit('change', [
        { added: [REMOTE_CLIENT_ID], updated: [], removed: [] },
        'remote',
      ]);
    }).not.toThrow();
  });
});
