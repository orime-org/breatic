// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { DocumentToolbar } from '@web/spaces/document/DocumentToolbar';
import { SelectionBubbleBar } from '@web/spaces/document/SelectionBubbleBar';
import type { DocumentHistoryState } from '@web/spaces/document/use-document-history';

interface DocumentEditorProps {
  /** The live editor, created and owned by the container. */
  editor: Editor;
  /** Undo / redo availability, read from the undo manager by the container. */
  history: DocumentHistoryState;
  /** True for a viewer; the toolbar renders inert. */
  readOnly?: boolean;
}

/**
 * The document editor's chrome: toolbar above, scrolling body below.
 *
 * Takes the editor rather than creating it, so the container owns the
 * collaborative wiring and this stays a presentation component.
 * @param root0 - Editor chrome props.
 * @param root0.editor - The editor to render and to drive the toolbar from.
 * @param root0.history - Undo / redo availability.
 * @param root0.readOnly - True for a viewer; disables the toolbar.
 * @returns The toolbar and editor body.
 */
export const DocumentEditor = React.memo(function DocumentEditor({
  editor,
  history,
  readOnly = false,
}: DocumentEditorProps): React.JSX.Element {
  return (
    <>
      <DocumentToolbar
        editor={editor}
        history={history}
        readOnly={readOnly}
      />
      {/* Overlay scrollbar (#1773): appears only while scrolling, takes no
          layout space. The side gutters live on the viewport — they are the
          margin OUTSIDE the page, and a click there is outside the document.
          The top and bottom breathing room does not: it belongs to the
          editable surface itself, or the strip of it below the last block
          answers no clicks (see `index.css`, `.doc-body-editor .ProseMirror`). */}
      <ScrollArea className='doc-body-scroller flex-1' viewportClassName='px-6'>
        <EditorContent
          editor={editor}
          data-testid='document-editor-content'
          className='doc-body-editor mx-auto max-w-3xl [&_.ProseMirror]:outline-none'
        />
      </ScrollArea>
      {/* Rendered as a sibling of the scroller, not inside it: the bar has to
          escape that clipping context, and the plugin needs somewhere outside
          it to append to. */}
      <SelectionBubbleBar editor={editor} readOnly={readOnly} />
    </>
  );
});
