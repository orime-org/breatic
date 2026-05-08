import React from 'react';
import type { TextEditorProps } from './types';
import 'highlight.js/styles/github-dark.css';
import '@/spaces/document/editor.css';

/**
 * TextEditor entry.
 *
 * TODO(PR-6): Wire TipTap to `body: Y.XmlFragment` inside the project-level
 * Yjs doc (via `useCanvasYjsInternal` or a dedicated hook) once `body` is
 * added to `CanvasNodeFields.data` in `@breatic/shared`.
 *
 * The per-node Yjs doc machinery (`useYjsNodeEditor` / `YjsNodeEditorManager`)
 * was deleted in PR-5. Until PR-6 lands, text nodes show a placeholder.
 */
const TextEditor = ({ nodeId: _nodeId }: TextEditorProps) => {
  return (
    <div className='flex h-full w-full flex-col items-center justify-center gap-3 bg-background-default-secondary text-text-default-tertiary'>
      <span className='text-sm'>Text editor coming soon</span>
    </div>
  );
};

// TODO(PR-6): TextEditorInner (TipTap + Collaboration + RightToolbar) will be
// restored here once `body: Y.XmlFragment` is embedded in the project-level
// nodesMap and the per-node Yjs doc architecture is no longer needed.

export default TextEditor;
