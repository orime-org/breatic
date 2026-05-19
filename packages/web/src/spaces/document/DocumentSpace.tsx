import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import * as React from 'react';

import type { SpaceBodyProps } from '@/spaces';
import { DocumentToolbar } from './DocumentToolbar';

/**
 * Document space body — minimal TipTap editor (StarterKit) wired to a
 * `DocumentToolbar`. PR 12 ships the structural editor + toolbar; richer
 * extensions (collaboration cursor / mention / highlight / table /
 * image embed) layer in during M2 polish.
 *
 * Content is local state for now; Yjs collaboration arrives when the
 * Document Yjs binding ships (M2 milestone).
 */
export function DocumentSpace({ spaceId, projectId }: SpaceBodyProps) {
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
      <div className='flex-1 overflow-auto'>
        <EditorContent
          editor={editor}
          data-testid='document-editor-content'
          className='prose prose-sm mx-auto max-w-3xl px-6 py-4 focus:outline-none'
        />
      </div>
    </div>
  );
}
