// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Putting the bubble bar on screen, and opening one of its slots.
 *
 * The waits are not decoration. The bar reaches the document one render after
 * the selection changes, and a slot's menu one render after the pointer
 * arrives, so a synchronous query runs ahead of both and finds nothing.
 */

import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';

const live: Editor[] = [];
let doc: Y.Doc | null = null;

/**
 * An editor holding the given body, bound to a Y.Doc.
 *
 * A real Y.Doc rather than a plain editor, so {@link sharedBodyMarkup} can read
 * a command's effect off the shared document. `closeShared` takes the doc down
 * with the editors, so each case gets its own.
 *
 * The body arrives after construction: content given at construction collides
 * with the collaboration extension's initial sync — the body never lands and
 * the selection falls on an empty document.
 * @param bodyHtml - The body's HTML, or an empty string for an empty document.
 * @returns The editor.
 */
export function openSharedBody(bodyHtml: string): Editor {
  if (!doc) {
    doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  }
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  live.push(editor);
  if (bodyHtml) editor.commands.setContent(bodyHtml);
  return editor;
}

/**
 * The body as Yjs wrote it down, markup and all.
 *
 * Read off the Y.Doc rather than the editor: whether a command really ran is a
 * question about the shared document, and `getHTML()` answers about one
 * client's rendering of it.
 * @returns The body's nodes, serialised.
 * @throws {Error} When no editor has been opened yet.
 */
export function sharedBodyMarkup(): string {
  if (!doc) throw new Error('no shared document — call openSharedBody first');
  return documentBodyFragment(doc)
    .toArray()
    .map((node) => node.toString())
    .join('');
}

/** Destroys every editor and the Y.Doc behind them. Put this in `afterEach`. */
export function closeShared(): void {
  live.splice(0).forEach((editor) => {
    editor.destroy();
  });
  doc?.destroy();
  doc = null;
}

/**
 * Render the editor, carrier and all, into the document.
 * @param editor - An editor with its body already in place.
 */
export function mountDocumentEditor(editor: Editor): void {
  render(
    <TooltipProvider>
      <DocumentEditor editor={editor} />
    </TooltipProvider>,
  );
}

/**
 * Move the pointer onto one slot and wait for its menu.
 * @param slotId - That slot's test id.
 * @returns The opened menu element.
 */
export async function hoverOpenSlot(slotId: string): Promise<HTMLElement> {
  act(() => {
    fireEvent.pointerEnter(screen.getByTestId(slotId));
  });
  return waitFor(() => screen.getByTestId(`${slotId}-menu`));
}
