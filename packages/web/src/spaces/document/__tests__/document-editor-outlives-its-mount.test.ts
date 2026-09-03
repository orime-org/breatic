// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A20: the editor outlives the component that shows it.
 *
 * Switching Space tabs remounts the body — `SpaceOutlet` is keyed on the Space
 * id — and the undo stack, the selection and any in-flight composition belong
 * to the editor rather than to the Yjs document. `document-editor-cache` keeps
 * the editor across that switch so they survive; the file itself carries why
 * rescuing the undo stack alone is a dead end.
 *
 * On this stack that rests on one fact about BlockNote, which is what these
 * cases pin: `unmount()` is a TEARDOWN, not a detach. It runs the plugin views'
 * destroy, and two of those take the collaboration apart — `ySyncPlugin`'s
 * calls `binding.destroy()` (`y-prosemirror.cjs:309-310`) and `yUndoPlugin`'s
 * calls `undoManager.destroy()` (`:2182-2183`). So a body that unmounted the
 * editor on its way out would hand back an editor bound to nothing, and the
 * only reason to keep it would be gone.
 *
 * Mounting into the new container without unmounting first is therefore the
 * hand-off, and whether that is supported is a question about the library
 * rather than about us.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  createDocumentUndoManager,
  documentUndoExtension,
} from '@web/spaces/document/document-undo-blocknote';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor over a fresh document, with its own undo manager.
 * @returns The editor, the doc, the manager and the container it went into.
 */
function open(): {
  editor: ReturnType<typeof buildDocumentEditor>;
  doc: Y.Doc;
  manager: Y.UndoManager;
  root: HTMLElement;
  } {
  const doc = new Y.Doc();
  const manager = createDocumentUndoManager(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [documentUndoExtension(manager)],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  return { editor, doc, manager, root };
}

/** A fresh container attached to the page. */
function container(): HTMLElement {
  const next = document.createElement('div');
  document.body.appendChild(next);
  return next;
}

describe('mounting the same editor into a second container', () => {
  it('keeps the text, and puts the DOM in the new container', async () => {
    const { editor, root } = open();
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'written before the switch' },
    ] as never);
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(root.textContent).toContain('written before the switch');

    const next = container();
    editor.mount(next);

    expect(next.textContent).toContain('written before the switch');
    expect(editor.prosemirrorView).not.toBeUndefined();
  });

  it('keeps the undo stack', async () => {
    const { editor, manager } = open();
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'written before the switch' },
    ] as never);
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(manager.undoStack.length).toBeGreaterThan(0);

    editor.mount(container());

    expect(manager.undoStack.length).toBeGreaterThan(0);
    editor.undo();
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(editor.prosemirrorView!.state.doc.textContent).not.toContain(
      'written before the switch',
    );
  });

  it('survives being mounted into the SAME container twice', async () => {
    // React in StrictMode runs an effect, cleans it up and runs it again. The
    // body's cleanup does not unmount, so the second run mounts the same editor
    // into the element it is already in.
    const { editor, root } = open();
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'written once' },
    ] as never);
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });

    editor.mount(root);

    expect(root.textContent).toContain('written once');
    // One paragraph, one block — a second mount must not leave two copies.
    expect(root.querySelectorAll('.bn-block-content')).toHaveLength(1);
  });

  it('is still bound to the shared document afterwards', async () => {
    const { editor, doc } = open();
    editor.mount(container());

    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'written after the switch' },
    ] as never);
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });

    expect(documentBodyFragment(doc).toString()).toContain(
      'written after the switch',
    );
  });
});

describe('unmounting is a teardown', () => {
  it('leaves a view that raises on the way through', () => {
    // Which is why the body must NOT unmount on its way out, and why evicting
    // a closed tab's editor is exactly this call. What is left answers the
    // getter and then raises on the first property read, which is the shape
    // `use-collab-caret-presence` has to survive during a tab switch.
    const { editor } = open();
    expect(editor.prosemirrorView?.dom).toBeDefined();

    editor.unmount();
    mounted.length = 0;

    expect(() => editor.prosemirrorView?.dom).toThrow();
  });
});
