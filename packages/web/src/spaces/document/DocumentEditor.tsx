// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';
import { DocumentCommandRail } from '@web/spaces/document/DocumentCommandRail';
import { SelectionBubbleBar } from '@web/spaces/document/SelectionBubbleBar';

interface DocumentEditorProps {
  /** The live editor, created and owned by the container. */
  editor: Editor;
  /** True for a viewer. */
  readOnly?: boolean;
}

/**
 * The document editor's chrome: the scrolling body, and the command rail at
 * its right edge.
 *
 * Takes the editor rather than creating it, so the container owns the
 * collaborative wiring and this stays a presentation component.
 *
 * The commands reach people through three carriers that follow what they act
 * on — the selection bubble bar, the block handle menu, the insert menu — plus
 * this rail for commands whose object is the whole document (design §3.0).
 * @param root0 - Editor chrome props.
 * @param root0.editor - The editor to render.
 * @param root0.readOnly - True for a viewer.
 * @returns The editor body, the rail and the bubble bar.
 */
export const DocumentEditor = React.memo(function DocumentEditor({
  editor,
  readOnly = false,
}: DocumentEditorProps): React.JSX.Element {
  return (
    <div className='relative flex min-h-0 flex-1 flex-col'>
      <DocumentCommandRail />
      {/* Overlay scrollbar (#1773): appears only while scrolling, takes no
          layout space. The side gutters live on the viewport — they are the
          margin OUTSIDE the page, and a click there is outside the document.
          The top and bottom breathing room does not: it belongs to the
          editable surface itself, or the strip of it below the last block
          answers no clicks (see `index.css`, `.doc-body-editor .ProseMirror`). */}
      <ScrollArea
        className={`${BODY_SCROLLER_CLASS} flex-1`}
        viewportClassName='px-6'
      >
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
    </div>
  );
});
