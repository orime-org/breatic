import type { Range } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { getTextEditorBridgeStorage } from '../extensions/TextEditorBridgeExtension';

type OpenGenerationAIMenuAtBottomOptions = {
  replacement?: string | null;
  deleteRange?: Range | null;
};

function clampToDoc(pos: number, docSize: number): number {
  return Math.max(0, Math.min(pos, docSize));
}

export function openGenerationAIMenuAtBottom(
  editor: Editor,
  options: OpenGenerationAIMenuAtBottomOptions = {},
): void {
  const { replacement = null, deleteRange = null } = options;
  const { view } = editor;
  let tr = editor.state.tr;

  if (deleteRange) {
    const from = clampToDoc(deleteRange.from, tr.doc.content.size);
    const to = clampToDoc(deleteRange.to, tr.doc.content.size);
    if (to > from) tr = tr.delete(from, to);
  }

  let selectionPos = clampToDoc(tr.doc.content.size, tr.doc.content.size);
  const highlightBlockType = tr.doc.type.schema.nodes.highlightBlock;
  const highlightBlockNode = highlightBlockType?.createAndFill({ aiPlaceholder: true });

  if (highlightBlockNode) {
    tr = tr.insert(selectionPos, highlightBlockNode);
    selectionPos = clampToDoc(selectionPos + 1, tr.doc.content.size);
  } else {
    tr = tr.insertText('\n', selectionPos);
    selectionPos = clampToDoc(selectionPos + 1, tr.doc.content.size);
  }

  const cursorPos = Math.max(1, selectionPos);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos)).scrollIntoView();
  view.dispatch(tr);

  const scrollRoot = view.dom.closest('.breatic-editor-scroll') as HTMLElement | null;
  if (scrollRoot) {
    scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: 'auto' });
  }

  requestAnimationFrame(() => {
    if (scrollRoot) {
      scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: 'auto' });
    }
    getTextEditorBridgeStorage(editor).openGenerationAIMenu?.(replacement);
  });
}
