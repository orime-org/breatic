import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, useEditorState, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
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
import { useImageEditorStore as useProjectStore } from '@/hooks/useImageEditorStore';
import type { CanvasWorkflowNodeData } from '@/apps/project/components/canvas/types';
import type { TextEditorProps } from './types';
import EditorMenus from './ui/EditorMenus';
import BlockLineControl from './ui/BlockLineControl';
import RightToolbar from './ui/RightToolbar';
import AIMenu from './ui/AIMenu';
import TableOfContents from './toc/TableOfContents';
import 'highlight.js/styles/github-dark.css';
import '@/styles/editor.css';

const TextEditor = ({ nodeId }: TextEditorProps) => {
  const { nodes, updateNode } = useProjectStore();
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const contentFromNode = useMemo(() => {
    const n = nodes.find((x) => x.id === nodeId);
    const d = n?.data as Partial<CanvasWorkflowNodeData> | undefined;
    return typeof d?.content === 'string' ? d.content : '';
  }, [nodes, nodeId]);

  const lastWrittenHtmlRef = useRef<string | null>(null);
  const lastPersistedHtmlRef = useRef<string | null>(null);
  const pendingSyncHtmlRef = useRef<string | null>(null);
  const pendingSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isApplyingRemoteRef = useRef(false);

  const persistEditorHtml = useCallback((html: string) => {
    if (isApplyingRemoteRef.current) return;
    if (html === lastPersistedHtmlRef.current) return;

    const cur = (nodesRef.current.find((x) => x.id === nodeId)?.data ?? {}) as Record<string, unknown>;
    if (typeof cur.content === 'string' && cur.content === html) {
      lastPersistedHtmlRef.current = html;
      return;
    }

    updateNode(nodeId, {
      data: {
        ...cur,
        name: typeof cur.name === 'string' && cur.name ? cur.name : 'text',
        content: html,
        state: 'idle',
        nodeRuntimeData: {
          ...((cur.nodeRuntimeData as Record<string, unknown>) ?? {}),
          runType: 'parameter',
        },
      },
    });
    lastPersistedHtmlRef.current = html;
  }, [nodeId, updateNode]);

  const flushPendingEditorSync = useCallback(() => {
    if (pendingSyncTimerRef.current) {
      clearTimeout(pendingSyncTimerRef.current);
      pendingSyncTimerRef.current = null;
    }
    const html = pendingSyncHtmlRef.current;
    if (html == null) return;
    pendingSyncHtmlRef.current = null;
    persistEditorHtml(html);
  }, [persistEditorHtml]);

  const scheduleEditorSync = useCallback((html: string) => {
    pendingSyncHtmlRef.current = html;
    if (pendingSyncTimerRef.current) clearTimeout(pendingSyncTimerRef.current);
    pendingSyncTimerRef.current = setTimeout(() => {
      pendingSyncTimerRef.current = null;
      const nextHtml = pendingSyncHtmlRef.current;
      if (nextHtml == null) return;
      pendingSyncHtmlRef.current = null;
      persistEditorHtml(nextHtml);
    }, 180);
  }, [persistEditorHtml]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ dropcursor: false, codeBlock: false }),
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
          if (node.type.name === 'paragraph') return 'Enter text or type \'/\' for commands…';
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
    content: contentFromNode || '',
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
    onCreate: ({ editor: ed }) => {
      const html = ed.getHTML();
      lastWrittenHtmlRef.current = html;
      lastPersistedHtmlRef.current = html;
    },
    onTransaction: ({ editor: ed, transaction }) => {
      if (!transaction.docChanged) return;
      const html = ed.getHTML();
      lastWrittenHtmlRef.current = html;
      if (isApplyingRemoteRef.current) return;
      scheduleEditorSync(html);
    },
    onBlur: () => {
      flushPendingEditorSync();
    },
  });

  const [aiMenuOpen, setAIMenuOpen] = useState(false);
  const [aiAnchorPos, setAiAnchorPos] = useState<number | null>(null);
  const [aiCursorPos, setAiCursorPos] = useState<number | null>(null);
  const [aiCursorHintRect, setAiCursorHintRect] = useState<{ top: number; left: number; height: number } | null>(null);
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
    setAiCursorPos(from);
    setAiInitialReplacement(initialReplacement);
    setAIMenuOpen(true);
  }, [editor]);

  const handleCloseGenerationAIMenu = useCallback(() => {
    setAIMenuOpen(false);
    setAiAnchorPos(null);
    setAiCursorPos(null);
    setAiCursorHintRect(null);
    setAiInitialReplacement(null);
    editor?.commands.focus();
  }, [editor]);

  const hideAiCursorHint = useCallback(() => {
    setAiCursorPos(null);
    setAiCursorHintRect(null);
  }, []);

  const updateAiCursorHintRect = useCallback((ed: Editor, pos: number) => {
    const docSize = ed.state.doc.content.size;
    const basePos = Math.max(1, Math.min(pos, Math.max(1, docSize)));
    const candidates = [basePos, Math.max(1, basePos - 1), Math.min(Math.max(1, docSize), basePos + 1)];
    for (const p of candidates) {
      try {
        const coords = ed.view.coordsAtPos(p);
        const lineHeight = Math.max(12, coords.bottom - coords.top);
        const hintHeight = Math.max(10, lineHeight * 0.8);
        const verticalOffset = (lineHeight - hintHeight) / 2;
        setAiCursorHintRect({
          left: coords.left,
          top: coords.top + verticalOffset,
          height: hintHeight,
        });
        return;
      } catch {
        // Try nearby position.
      }
    }
    setAiCursorHintRect(null);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const bridge = getTextEditorBridgeStorage(editor);
    bridge.openGenerationAIMenu = handleOpenGenerationAIMenu;
    return () => {
      bridge.openGenerationAIMenu = null;
    };
  }, [editor, handleOpenGenerationAIMenu]);

  useEffect(() => {
    if (!aiMenuOpen || aiCursorPos == null || !editor) return;
    updateAiCursorHintRect(editor, aiCursorPos);

    const onViewportChange = () => updateAiCursorHintRect(editor, aiCursorPos);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [aiMenuOpen, aiCursorPos, editor, updateAiCursorHintRect]);

  useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  useEffect(() => {
    if (!editor) return;
    const incoming = contentFromNode;
    if (incoming === lastWrittenHtmlRef.current) return;
    const curHtml = editor.getHTML();
    if (incoming === curHtml) {
      lastWrittenHtmlRef.current = incoming;
      lastPersistedHtmlRef.current = incoming;
      return;
    }

    // Incoming remote content wins: cancel any pending local write based on stale html.
    if (pendingSyncTimerRef.current) {
      clearTimeout(pendingSyncTimerRef.current);
      pendingSyncTimerRef.current = null;
    }
    pendingSyncHtmlRef.current = null;

    isApplyingRemoteRef.current = true;
    editor.commands.setContent(incoming, { emitUpdate: false });
    const appliedHtml = editor.getHTML();
    lastWrittenHtmlRef.current = appliedHtml;
    lastPersistedHtmlRef.current = appliedHtml;
    queueMicrotask(() => {
      isApplyingRemoteRef.current = false;
    });
  }, [editor, contentFromNode]);

  useEffect(() => {
    if (!editor) return;
    return () => {
      if (!editor.isDestroyed) editor.destroy();
    };
  }, [editor]);

  useEffect(() => () => {
    if (pendingSyncTimerRef.current) {
      clearTimeout(pendingSyncTimerRef.current);
      pendingSyncTimerRef.current = null;
    }
  }, []);

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
              <RightToolbar editor={editor} nodeId={nodeId} onOpenAIMenu={handleOpenGenerationAIMenu} />
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
          onPreviewApplied={hideAiCursorHint}
          initialReplacement={aiInitialReplacement}
        />
      )}
      {editor && aiMenuOpen && aiCursorHintRect && (
        <div
          className='pointer-events-none fixed rounded-full bg-[#4F46E5] shadow-[0_0_0_1px_rgba(79,70,229,0.25),0_0_10px_rgba(79,70,229,0.6)] animate-pulse'
          style={{
            zIndex: 100,
            top: aiCursorHintRect.top,
            left: aiCursorHintRect.left - 1,
            width: 3,
            height: aiCursorHintRect.height,
          }}
          aria-hidden
        />
      )}
    </>
  );
};

export default TextEditor;
