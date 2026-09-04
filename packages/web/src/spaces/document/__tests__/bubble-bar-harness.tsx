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

import { expect } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { DOMParser } from '@tiptap/pm/model';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';

/** The editor these cases open. */
export type HarnessEditor = ReturnType<typeof buildDocumentEditor>;

const live: HarnessEditor[] = [];
const surfaces = new Map<HarnessEditor, HTMLElement>();
let doc: Y.Doc | null = null;

/**
 * An editor holding the given body, bound to a Y.Doc.
 *
 * A real Y.Doc rather than a plain editor, so {@link sharedBodyMarkup} can read
 * a command's effect off the shared document. `closeShared` takes the doc down
 * with the editors, so each case gets its own.
 *
 * The editor is mounted here, on the surface it keeps for the rest of its life
 * — the collaboration binding is built by the sync plugin's VIEW, so writing a
 * body into an unmounted editor would reach a private document. The surface is
 * what {@link mountDocumentEditor} then moves into the page.
 * @param bodyHtml - The body's HTML, or an empty string for an empty document.
 * @returns The editor, holding the body.
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
  const surface = document.createElement('div');
  document.body.appendChild(surface);
  surfaces.set(editor, surface);
  editor.mount(surface);
  if (bodyHtml) {
    const holder = document.createElement('div');
    holder.innerHTML = bodyHtml;
    const parsed = DOMParser.fromSchema(editor.pmSchema).parse(holder);
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content),
    );
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

/**
 * The shared document these editors are bound to.
 * @returns That document.
 * @throws {Error} When no editor has been opened yet.
 */
export function sharedDoc(): Y.Doc {
  if (!doc) throw new Error('no shared document — call openSharedBody first');
  return doc;
}

/** Takes down every editor and the Y.Doc behind them. Put this in `afterEach`. */
export function closeShared(): void {
  live.splice(0).forEach((editor) => {
    editor.unmount();
    surfaces.get(editor)?.remove();
    surfaces.delete(editor);
  });
  doc?.destroy();
  doc = null;
}

/**
 * Render the editor, carrier and all, into the document.
 *
 * Wrapped in a provider to stand in for App: the whole product has one
 * `TooltipProvider`, mounted in `App.tsx`, and the bar's entries that are not
 * open yet explain themselves through a tooltip.
 * @param editor - An editor with its body already in place.
 * @param readOnly - True for a viewer.
 */
export function mountDocumentEditor(
  editor: HarnessEditor,
  readOnly = false,
): void {
  const surface = surfaces.get(editor);
  if (!surface) throw new Error('open the editor with openSharedBody first');
  render(
    <TooltipProvider>
      <DocumentEditor
        handle={{ editor, surface }}
        readOnly={readOnly}
      />
    </TooltipProvider>,
  );
}

/**
 * Puts the caret's own element in focus, so the bar counts the selection.
 * @param editor - The editor, mounted.
 */
export function focusBody(editor: HarnessEditor): void {
  editor.prosemirrorView?.dom.focus();
}

/**
 * Selects the block holding the given text.
 * @param editor - The editor.
 * @param text - The text to look for.
 * @throws {Error} When no block holds it.
 */
export function selectBlockText(editor: HarnessEditor, text: string): void {
  let span: { from: number; to: number } | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (span !== null || !node.isTextblock) return span === null;
    if (node.textContent !== text) return true;
    span = { from: pos + 1, to: pos + node.nodeSize - 1 };
    return false;
  });
  if (span === null) throw new Error(`no block holding ${JSON.stringify(text)}`);
  const view = editor.prosemirrorView!;
  const { from, to } = span;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
  );
}

/**
 * Selects a span of the body's text, counted in characters.
 *
 * Offsets rather than ProseMirror positions: the flat model wraps every block
 * in two more nodes than the nested one did, so a position written as a number
 * would say nothing about what it points at and would have to be re-derived by
 * hand on the next structural change. Characters are what the cases mean.
 * @param editor - The editor.
 * @param from - The first character of the span.
 * @param to - One past its last character.
 * @throws {Error} When the body holds fewer characters than that.
 */
export function selectTextRange(
  editor: HarnessEditor,
  from: number,
  to: number,
): void {
  let seen = 0;
  let start: number | null = null;
  let end: number | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const length = node.text?.length ?? 0;
    if (start === null && seen + length >= from) start = pos + (from - seen);
    if (end === null && seen + length >= to) end = pos + (to - seen);
    seen += length;
    return true;
  });
  if (start === null || end === null) {
    throw new Error(`the body holds fewer than ${String(to)} characters`);
  }
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, start, end),
    ),
  );
}

/**
 * Selects from the first character of the body to the last.
 * @param editor - The editor.
 */
export function selectWholeBody(editor: HarnessEditor): void {
  const view = editor.prosemirrorView!;
  const { doc } = view.state;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(doc, 1, doc.content.size - 1),
    ),
  );
}

/**
 * Selects the whole document, the way `Mod-a`'s second tier does.
 *
 * An `AllSelection` rather than a text range over the same characters: the two
 * are different kinds, and the bar pins itself to the pointer for one of them.
 * @param editor - The editor.
 */
export function selectEverything(editor: HarnessEditor): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(new AllSelection(view.state.doc)),
  );
}

/**
 * Waits for the bar to reach the document.
 *
 * It arrives one render after the selection moves, so a query that runs
 * straight after a dispatch finds nothing.
 */
export async function waitForBar(): Promise<void> {
  await waitFor(() => {
    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
    ).toBeGreaterThan(0);
  });
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
