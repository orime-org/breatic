// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import type { SpaceBodyProps } from '@web/spaces';
import { DocumentToolbar } from '@web/spaces/document/DocumentToolbar';

/**
 * Document space body — minimal TipTap editor (StarterKit) wired to a
 * `DocumentToolbar`. PR 12 ships the structural editor + toolbar; richer
 * extensions (collaboration cursor / mention / highlight / table /
 * image embed) layer in during M2 polish.
 *
 * Content is local state for now; Yjs collaboration arrives when the
 * Document Yjs binding ships (M2 milestone).
 * @param root0 - Space body props supplied by the project space outlet.
 * @param root0.spaceId - ID of the document space, stamped on the root element for selectors.
 * @param root0.projectId - ID of the owning project, stamped on the root element for selectors.
 * @returns The document editor element, or a loading placeholder while TipTap initializes.
 */
export function DocumentSpace({
  spaceId,
  projectId,
}: SpaceBodyProps): React.JSX.Element {
  const editor = useEditor({
    extensions: [StarterKit],
    content: '<p></p>',
  });

  if (!editor) {
    return (
      <div
        data-testid='document-space-loading'
        className='flex h-full w-full items-center justify-center text-sm text-muted-foreground'
      >
        Loading editor…
      </div>
    );
  }

  return (
    <div
      data-testid='document-space'
      data-project-id={projectId}
      data-space-id={spaceId}
      className='flex h-full w-full flex-col bg-background'
    >
      <DocumentToolbar editor={editor} />
      {/* ScrollArea (#1773): overlay scrollbar — appears only while
          scrolling, no layout space, hover changes color only. */}
      <ScrollArea className='flex-1'>
        <EditorContent
          editor={editor}
          data-testid='document-editor-content'
          className='prose prose-sm mx-auto max-w-3xl px-6 py-4 focus:outline-none'
        />
      </ScrollArea>
    </div>
  );
}
