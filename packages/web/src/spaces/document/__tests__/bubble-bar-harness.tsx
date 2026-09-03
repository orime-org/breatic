// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Putting the bubble bar on screen, and opening one of its slots.
 *
 * The waits are not decoration. The bar reaches the document one render after
 * the selection changes, and a slot's menu one render after the pointer
 * arrives, so a synchronous query runs ahead of both and finds nothing.
 *
 * The body still arrives as HTML. ProseMirror's own parser reads it against
 * the flat schema and produces the wrappers the model wants — measured,
 * `<p>a</p><h2>b</h2>` comes back as
 * `blockGroup(blockContainer(paragraph), blockContainer(heading))` — so the
 * cases go on saying what they mean in markup rather than in a block shape
 * they would have to keep in step with the schema. BlockNote's own HTML
 * parser is asynchronous, which every case that opens a body would have to
 * become.
 */

import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { DOMParser } from '@tiptap/pm/model';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';

/** The editor these cases open. */
export type HarnessEditor = ReturnType<typeof buildDocumentEditor>;

const live: HarnessEditor[] = [];
let doc: Y.Doc | null = null;

/**
 * An editor holding the given body, bound to a Y.Doc.
 *
 * A real Y.Doc rather than a plain editor, so {@link sharedBodyMarkup} can read
 * a command's effect off the shared document. `closeShared` takes the doc down
 * with the editors, so each case gets its own.
 *
 * The body arrives after construction: content given at construction collides
 * with the collaboration layer's initial sync — the body never lands and the
 * selection falls on an empty document.
 * @param bodyHtml - The body's HTML, or an empty string for an empty document.
 * @returns The editor, not yet mounted.
 */
export function openSharedBody(bodyHtml: string): HarnessEditor {
  if (!doc) {
    doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  }
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
  });
  live.push(editor);
  if (bodyHtml) {
    const holder = document.createElement('div');
    holder.innerHTML = bodyHtml;
    const parsed = DOMParser.fromSchema(editor.pmSchema).parse(holder);
    editor.transact((tr) => {
      tr.replaceWith(0, tr.doc.content.size, parsed.content);
    });
  }
  return editor;
}

/**
 * The body as Yjs wrote it down, markup and all.
 *
 * Read off the Y.Doc rather than the editor: whether a command really ran is a
 * question about the shared document, and a client's own rendering answers
 * about one client.
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

/** Takes down every editor and the Y.Doc behind them. Put this in `afterEach`. */
export function closeShared(): void {
  live.splice(0).forEach((editor) => {
    editor.unmount();
  });
  doc?.destroy();
  doc = null;
}

/**
 * Render the editor, carrier and all, into the document.
 * @param editor - An editor with its body already in place.
 */
export function mountDocumentEditor(editor: HarnessEditor): void {
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
