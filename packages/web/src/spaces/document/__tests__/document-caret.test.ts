// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A22: remote carets, drawn by a plugin this Space registers itself.
 *
 * BlockNote's cursor extension writes `awareness.setLocalStateField('user',
 * ...)` in its factory body the moment it finds an awareness through
 * `options.provider` (`YCursorPlugin.ts:72-86`), and that write is the one
 * thing #1886 delivered the opposite of: this client never states who it is.
 * So the awareness never reaches BlockNote, and the cursor plugin is
 * registered here instead — same plugin, same renderers, without the write.
 *
 * The third case is the experiment §10.1 left for landing time. `@tiptap/y-tiptap`
 * drops every remote decoration on a local structural edit and waits for the
 * collaborator to publish a new cursor, a wait that never ends; that is why
 * `collab-caret-refresh.ts` exists. y-prosemirror's own cursor plugin has no
 * such branch — `cursor-plugin.js:188` maps the decorations through
 * `prevState.map(tr.mapping, tr.doc)` — so whether the refresh is needed at
 * all is a question to answer by pressing Enter and looking.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentCaretExtension } from '@web/spaces/document/document-caret';

const REMOTE_CLIENT_ID = 4242;

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];
const opened: { awareness: Awareness; doc: Y.Doc }[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  opened.splice(0).forEach(({ awareness, doc }) => {
    awareness.destroy();
    doc.destroy();
  });
});

/**
 * Opens an editor with the caret plugin registered over its own awareness.
 * @returns The editor, the doc, the awareness, and the element it rendered into.
 */
function open(): {
  editor: ReturnType<typeof buildDocumentEditor>;
  doc: Y.Doc;
  awareness: Awareness;
  root: HTMLElement;
  } {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  opened.push({ awareness, doc });

  const body = documentBodyFragment(doc);
  const editor = buildDocumentEditor({
    fragment: body,
    extensions: [
      documentCaretExtension(awareness, (userId) =>
        userId === 'u-them' ? 'Them' : null,
      ),
    ],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'shared sentence' },
  ] as never);
  return { editor, doc, awareness, root };
}

/**
 * Puts a collaborator's caret into the document, the way the wire delivers it.
 * @param doc - The shared document.
 * @param awareness - The awareness the plugin reads.
 */
async function remoteCaretArrives(
  doc: Y.Doc,
  awareness: Awareness,
): Promise<void> {
  const cursor = Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(documentBodyFragment(doc), 0),
  );
  (awareness.states as Map<number, unknown>).set(REMOTE_CLIENT_ID, {
    user: { id: 'u-them' },
    cursor: { anchor: cursor, head: cursor },
  });
  awareness.emit('change', [
    { added: [REMOTE_CLIENT_ID], updated: [], removed: [] },
    'remote',
  ]);
  // The plugin answers the awareness event by dispatching a transaction of its
  // own, so the decorations land on the next tick rather than in this one.
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** How many collaborator carets are painted. */
function caretCount(root: HTMLElement): number {
  return root.querySelectorAll('.collaboration-carets__caret').length;
}

/** The name shown on the painted caret. */
function caretLabel(root: HTMLElement): string {
  return (
    root.querySelector('.collaboration-carets__label')?.textContent?.trim() ??
    ''
  );
}

describe('the caret plugin this Space registers', () => {
  it('draws a collaborator’s caret, with the name the roster resolves', async () => {
    const { doc, awareness, root } = open();
    await remoteCaretArrives(doc, awareness);

    expect(caretCount(root)).toBe(1);
    expect(caretLabel(root)).toBe('Them');
  });

  it('stamps the client id the focus and roster listeners key off', async () => {
    const { doc, awareness, root } = open();
    await remoteCaretArrives(doc, awareness);

    const caret = root.querySelector('.collaboration-carets__caret');
    expect(caret?.getAttribute('data-client-id')).toBe(
      String(REMOTE_CLIENT_ID),
    );
  });

  it('keeps the caret through a local structural edit', async () => {
    // The §10.1 experiment: press Enter and look. The collaborator has not
    // moved and will not — an idle client's heartbeats are deep-equal and
    // never reach the cursor plugin.
    const { editor, doc, awareness, root } = open();
    await remoteCaretArrives(doc, awareness);
    expect(caretCount(root)).toBe(1);

    const view = editor.prosemirrorView!;
    editor.setTextCursorPosition(
      (editor.document as unknown as { id: string }[])[0]!.id,
      'end',
    );
    view.someProp('handleKeyDown', (handler) =>
      handler(
        view,
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );

    expect(editor.document).toHaveLength(2);
    expect(caretCount(root)).toBe(1);
    expect(caretLabel(root)).toBe('Them');
  });

  it('states nothing about who this client is', () => {
    const { awareness } = open();
    // The plugin publishes this client's cursor position, which is a
    // position and not an identity.
    expect(awareness.getLocalState()?.['user']).toBeUndefined();
  });
});
