import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, useEditorState, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import Underline from '@tiptap/extension-underline';
import { TextStyle, Color, BackgroundColor } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { BreaticImage } from './extensions/BreaticImageExtension';
import { BreaticTableCell, BreaticTableHeader } from './table/TableCellBackground';
import { SlashCommandExtension } from './slash/SlashCommand';
import { breaticSlashMenuKey, closeBreaticSlashMenu } from './slash/SlashMenuPlugin';
import {
  TextEditorBridgeExtension,
  getTextEditorBridgeStorage,
} from './extensions/TextEditorBridgeExtension';
import ImageFilePanel from './media/ImageFilePanel';
import { PendingImage } from './extensions/PendingImageExtension';
import { PendingVideo } from './extensions/PendingVideoExtension';
import { PendingAudio } from './extensions/PendingAudioExtension';
import { PendingFile } from './extensions/PendingFileExtension';
import { HeadingFold } from './extensions/HeadingFoldExtension';
import { FormatBubbleSuppress } from './extensions/FormatBubbleSuppressExtension';
import { BlockIndent } from './extensions/BlockIndentExtension';
import { BreaticVideo } from './extensions/BreaticVideoExtension';
import { BreaticAudio } from './extensions/BreaticAudioExtension';
import { BreaticCodeBlock } from './extensions/breaticCodeBlockView';
import { HighlightBlock } from './extensions/HighlightBlockExtension';
import MediaFilePanel from './media/MediaFilePanel';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { useYjsNodeEditor } from '@/hooks/useYjsNodeEditor';
import type { YjsNodeEditorManager } from '@/utils/yjsNodeEditorManager';
import type { TextEditorProps } from './types';
import EditorMenus from './ui/EditorMenus';
import BlockLineControl from './ui/BlockLineControl';
import RightToolbar from './ui/RightToolbar';
import AIMenu from './ui/AIMenu';
import TableOfContents from './toc/TableOfContents';
import 'highlight.js/styles/github-dark.css';
import '@/styles/editor.css';

/**
 * Debounce for the summary write-back to the main canvas node.
 *
 * 500ms balances two concerns:
 *   - too short (~180ms used historically) means every keystroke
 *     triggers a `nodesMap` `.set('content', …)` on the main canvas
 *     Y.Doc — each collaborator on the project canvas then receives
 *     the churn
 *   - too long (~2s) means the node card preview and any LLM prompt
 *     referencing the node lag visibly behind the editor
 */
const SUMMARY_WRITEBACK_DEBOUNCE_MS = 500;

/**
 * TextEditor entry — splits into `TextEditor` (auth + Yjs gate) and
 * `TextEditorInner` (actual TipTap instance) so React hook order stays
 * stable across the manager-ready transition.
 */
const TextEditor = ({ nodeId }: TextEditorProps) => {
  const { workflowId } = useCanvasUI();
  const { manager, loading } = useYjsNodeEditor({
    projectId: workflowId,
    nodeId,
  });

  if (!manager) {
    return loading ? (
      <div className='flex h-full w-full items-center justify-center bg-background-default-secondary text-text-default-base'>
        Loading…
      </div>
    ) : null;
  }

  // key=docName guarantees a full remount when the user switches to a
  // different text node — avoids the TipTap editor holding a reference
  // to a destroyed Y.XmlFragment from the previous manager.
  return <TextEditorInner key={manager.docName} nodeId={nodeId} manager={manager} />;
};

interface TextEditorInnerProps {
  nodeId: string;
  manager: YjsNodeEditorManager;
}

/**
 * Inner TipTap host — only mounts when the Yjs node editor manager is
 * ready. Owns three data flows:
 *
 *   1. TipTap ↔ Y.XmlFragment `body` via the `Collaboration` extension
 *      (full CRDT, handles offline + multi-cursor).
 *   2. `body` observe → debounced HTML summary write-back to the main
 *      canvas node's `data.content`, so the card preview + LLM prompt
 *      references stay fresh. Summary is derived; never read back.
 *   3. Local UI state (AI menu, TOC) — unchanged from previous version.
 */
const TextEditorInner: React.FC<TextEditorInnerProps> = ({ nodeId, manager }) => {
  const { updateNode: updateMainCanvasNode } = useCanvasActions();

  const yBody = useMemo(() => manager.doc.getXmlFragment('body'), [manager]);

  // ── Summary write-back: debounced HTML → main canvas data.content ──
  //
  // `lastSyncedHtmlRef` dedupes echoes: when a remote collaborator edits,
  // TipTap's onUpdate fires locally too, but if the resulting HTML
  // matches what we last wrote we skip the re-set (Y.Map.set always
  // creates an op, even for equal values).
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHtmlRef = useRef<string | null>(null);
  const lastSyncedHtmlRef = useRef<string>('');

  const flushSummary = useCallback(() => {
    const html = pendingHtmlRef.current;
    pendingHtmlRef.current = null;
    if (html == null) return;
    if (html === lastSyncedHtmlRef.current) return;
    lastSyncedHtmlRef.current = html;
    updateMainCanvasNode(nodeId, {
      data: { content: html, state: 'idle' },
    });
  }, [nodeId, updateMainCanvasNode]);

  const scheduleSummaryWriteback = useCallback((html: string) => {
    pendingHtmlRef.current = html;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      flushSummary();
    }, SUMMARY_WRITEBACK_DEBOUNCE_MS);
  }, [flushSummary]);

  // ── TipTap editor ────────────────────────────────────────────
  //
  // `Collaboration` takes ownership of the document: we must NOT pass
  // `content` (would fight the Y.XmlFragment) and must disable
  // StarterKit's history (Collaboration provides its own). Everything
  // else is unchanged from the previous TipTap configuration.
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ dropcursor: false, codeBlock: false, undoRedo: false }),
      Collaboration.configure({ fragment: yBody }),
      BlockIndent,
      TaskList.configure({ HTMLAttributes: { class: 'task-list' } }),
      TaskItem.configure({ nested: true }),
      Underline,
      TextStyle,
      Color,
      BackgroundColor,
      TextAlign.configure({ types: ['heading', 'paragraph', 'table'] }),
      Link.configure({ openOnClick: false }),
      Highlight.configure({ multicolor: false }),
      HighlightBlock,
      Placeholder.configure({
        placeholder: ({ node }) => {
          if (node.type.name === 'paragraph' || node.type.name === 'highlightBlock') {
            return 'Enter text or type \'/\' for commands…';
          }
          return '';
        },
        showOnlyCurrent: true,
      }),
      PendingImage,
      PendingVideo,
      PendingAudio,
      PendingFile,
      BreaticImage.configure({
        inline: false,
        allowBase64: true,
        resize: {
          enabled: true,
          directions: ['left', 'right'] as const,
          minWidth: 64,
          minHeight: 48,
          alwaysPreserveAspectRatio: true,
        },
      }),
      Table.configure({
        resizable: true,
        cellMinWidth: 120,
        /** Lets gutter menu apply `textAlign` on the whole `table` node via `setNodeSelection`. */
        allowTableNodeSelection: true,
      }),
      TableRow,
      BreaticTableCell,
      BreaticTableHeader,
      BreaticVideo,
      BreaticAudio,
      BreaticCodeBlock,
      TextEditorBridgeExtension,
      SlashCommandExtension,
      HeadingFold,
      FormatBubbleSuppress,
    ],
    autofocus: false,
    editable: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      handleDOMEvents: {
        focusout: (view, event) => {
          const nextTarget = (event as FocusEvent).relatedTarget;
          if (nextTarget instanceof Element && nextTarget.closest('[data-breatic-slash-menu]')) {
            return false;
          }
          if (nextTarget instanceof Element && nextTarget.closest('[data-breatic-text-editor-ai-menu]')) {
            return false;
          }
          try {
            if (!breaticSlashMenuKey.getState(view.state)) return false;
            closeBreaticSlashMenu(view);
          } catch {
            // ignore when editor/view is being torn down
          }
          return false;
        },
      },
    },
    onUpdate: ({ editor: ed }) => {
      // Fires for both local edits and remote CRDT apply — we schedule
      // unconditionally and let `lastSyncedHtmlRef` dedupe equal HTML.
      scheduleSummaryWriteback(ed.getHTML());
    },
    onBlur: () => {
      // Commit any in-flight summary before the user's attention leaves
      // — keeps the node card preview current when they switch panels.
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      flushSummary();
    },
  }, [yBody]);

  // ── Unmount cleanup: flush any pending summary write ─────────
  //
  // Without this, edits made in the last <500ms before the user closes
  // the panel or switches nodes would be dropped.
  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      flushSummary();
    };
  }, [flushSummary]);

  // ── AI menu state (unchanged from previous version) ──────────
  const [aiMenuOpen, setAIMenuOpen] = useState(false);
  const [aiAnchorPos, setAiAnchorPos] = useState<number | null>(null);
  const [aiInitialReplacement, setAiInitialReplacement] = useState<string | null>(null);

  const handleOpenGenerationAIMenu = useCallback((initialReplacement: string | null = null) => {
    if (!editor) return;
    const { $from, from } = editor.state.selection;
    const blockTypesForAIMenuAnchor = new Set([
      'paragraph',
      'heading',
      'blockquote',
      'codeBlock',
      'listItem',
      'taskItem',
    ]);
    let anchorPos: number | null = null;
    for (let d = $from.depth; d >= 1; d -= 1) {
      const node = $from.node(d);
      if (blockTypesForAIMenuAnchor.has(node.type.name)) {
        anchorPos = $from.start(d);
        break;
      }
    }
    setAiAnchorPos(anchorPos ?? from);
    setAiInitialReplacement(initialReplacement);
    setAIMenuOpen(true);
  }, [editor]);

  const handleCloseGenerationAIMenu = useCallback(() => {
    setAIMenuOpen(false);
    setAiAnchorPos(null);
    setAiInitialReplacement(null);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const bridge = getTextEditorBridgeStorage(editor);
    bridge.openGenerationAIMenu = handleOpenGenerationAIMenu;
    return () => {
      bridge.openGenerationAIMenu = null;
    };
  }, [editor, handleOpenGenerationAIMenu]);

  useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  return (
    <>
      <div className='flex h-full w-full overflow-hidden text-text-default-base'>
        {editor && <TableOfContents editor={editor} />}
        <div
          className='breatic-editor-wrapper relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background-default-secondary'
        >
          <div className='breatic-editor-scroll relative min-h-0 min-w-0 flex-1 overflow-y-auto'>
            <div className='breatic-editor-body relative px-[84px] pb-32 pt-12'>
              <EditorContent editor={editor} />
              {editor && <EditorMenus editor={editor} generationAIMenuOpen={aiMenuOpen} />}
              {editor && <BlockLineControl editor={editor} />}
            </div>
            <ImageFilePanel />
            <MediaFilePanel />
          </div>
          {editor && (
            <div className='pointer-events-none absolute inset-y-0 right-3 z-10 flex flex-col items-end justify-center py-3'>
              <RightToolbar editor={editor} nodeId={nodeId} />
            </div>
          )}
        </div>
      </div>
      {editor && aiMenuOpen && aiAnchorPos != null && (
        <AIMenu
          editor={editor}
          anchorPos={aiAnchorPos}
          onClose={handleCloseGenerationAIMenu}
          menuVariant='generation'
          initialReplacement={aiInitialReplacement}
        />
      )}
    </>
  );
};

export default TextEditor;
