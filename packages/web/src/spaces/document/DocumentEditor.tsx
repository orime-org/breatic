// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';
import {
  adoptDocumentEditor,
  type ShowableEditor,
} from '@web/spaces/document/document-editor-cache';
import { DocumentMenuEntry } from '@web/spaces/document/DocumentMenuEntry';
import { SelectionBubbleBar } from '@web/spaces/document/SelectionBubbleBar';

interface DocumentEditorProps {
  /** The live editor and its surface, created and owned by the cache. */
  handle: ShowableEditor;
  /** True for a viewer. */
  readOnly?: boolean;
}

/**
 * The document editor's chrome: the scrolling body, the whole-document command
 * entry at its top right, and the selection bubble bar.
 *
 * Takes the editor rather than creating it, so the container owns the
 * collaborative wiring and this stays a presentation component.
 *
 * Which carrier a command belongs to follows what it acts on (design §3.0).
 * Two of them are here: the bubble bar for the selection, the entry for the
 * whole document. The block handle menu and the insert menu are task #113.
 * @param root0 - Editor chrome props.
 * @param root0.handle - The editor to render, with its surface.
 * @param root0.readOnly - True for a viewer.
 * @returns The editor body, the entry and the bubble bar.
 */
export const DocumentEditor = React.memo(function DocumentEditor({
  handle,
  readOnly = false,
}: DocumentEditorProps): React.JSX.Element {
  const body = React.useRef<HTMLDivElement>(null);
  // Held here because this is where the editor's DOM enters the scroller, and
  // the bar needs the element that now holds it. A child looking it up for
  // itself would look before this effect has run.
  const [viewport, setViewport] = React.useState<HTMLElement | null>(null);

  // A hand-off, not a construction: the editor belongs to
  // `document-editor-cache` and outlives every one of these renders. What
  // moves is the surface it is mounted on; the cleanup deliberately tears
  // nothing down, because `unmount()` takes the collaboration binding and the
  // undo manager apart and a Space-tab switch would hand back an editor bound
  // to nothing. Evicting a closed tab is where that teardown belongs.
  React.useEffect(() => {
    const container = body.current;
    if (container === null) return;
    adoptDocumentEditor(handle, container);
    setViewport(
      container.closest<HTMLElement>('[data-radix-scroll-area-viewport]'),
    );
  }, [handle]);

  return (
    // `isolate` keeps the z-values below local: the entry has to paint over
    // the body and the bubble bar over the entry, and neither of those two
    // relationships is anyone else's business. Without it both numbers would
    // be compared against every other layer on the page.
    <div className='relative isolate flex min-h-0 flex-1 flex-col'>
      {/* Overlay scrollbar (#1773): appears only while scrolling, takes no
          layout space. The side gutters live on the viewport — they are the
          margin OUTSIDE the page, and a click there is outside the document.
          The top and bottom breathing room does not: it belongs to the
          editable surface itself, or the strip of it below the last block
          answers no clicks (see `index.css`, `.doc-body-editor .ProseMirror`).
          The right gutter is also where the whole-document entry stands, which
          is what sizes both of them (`--doc-body-gutter`). */}
      <ScrollArea
        className={`${BODY_SCROLLER_CLASS} flex-1`}
        // `relative` makes the viewport the containing block for the link
        // panel's anchor, which is what lets that anchor scroll with the text
        // it points at. Nothing else inside is measured against it: the
        // whole-document entry is `sticky` (it answers to the scroller), the
        // caret that opens a document is `absolute` with no offsets and so
        // stays at its static position, and a remote caret's label is measured
        // against the caret itself.
        viewportClassName='relative px-[var(--doc-body-gutter)]'
      >
        <DocumentMenuEntry />
        <div
          ref={body}
          data-testid='document-editor-content'
          className='doc-body-editor mx-auto max-w-3xl [&_.ProseMirror]:outline-none'
        />
      </ScrollArea>
      {/* A sibling here, inside the scroller's viewport at runtime: the bar
          portals itself there, so the viewport's own overflow is what takes it
          away once it has been carried out of sight. Over a select-all it is
          pinned to the pointer and stays put instead (E2). */}
      {viewport !== null && (
        <SelectionBubbleBar
          editor={handle.editor}
          viewport={viewport}
          readOnly={readOnly}
        />
      )}
    </div>
  );
});
