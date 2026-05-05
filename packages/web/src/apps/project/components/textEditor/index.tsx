import React from 'react';
import type { TextEditorProps } from './types';
import 'highlight.js/styles/github-dark.css';
import '@/styles/editor.css';

/**
 * TextEditor entry.
 *
 * TODO(PR-6): Wire TipTap to `body: Y.XmlFragment` inside the project-level
 * Yjs doc (via `useCanvasYjsInternal` or a dedicated hook) once `body` is
 * added to `CanvasNodeFields.data` in `@breatic/shared`.
 *
 * The per-node Yjs doc machinery (`useYjsNodeEditor` / `YjsNodeEditorManager`)
 * was deleted in PR-5. Canvas text nodes use the local AI tools panel until PR-6.
 */
const TextEditor = (_props: TextEditorProps) => {
  return (
    <div className='flex h-full w-full flex-col bg-background-default-secondary text-text-default-tertiary' aria-label='Text editor placeholder' />
  );
};

// TODO(PR-6): TextEditorInner (TipTap + Collaboration + RightToolbar) will be
// restored here once `body: Y.XmlFragment` is embedded in the project-level
// nodesMap and the per-node Yjs doc architecture is no longer needed.

export default TextEditor;
