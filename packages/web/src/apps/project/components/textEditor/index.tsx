import React, { useEffect, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
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
import MediaFilePanel from './media/MediaFilePanel';
import { useProjectStore } from '@/hooks/useProjectStore';
import type { CanvasWorkflowNodeData } from '@/apps/project/components/canvas/types';
import type { TextEditorProps } from './types';
import EditorMenus from './ui/EditorMenus';
import BlockLineControl from './ui/BlockLineControl';
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
  const editorWrapperRef = useRef<HTMLDivElement | null>(null);
  const isApplyingRemoteRef = useRef(false);

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
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false }),
      Highlight.configure({ multicolor: false }),
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
      }),
      TableRow,
      BreaticTableCell,
      BreaticTableHeader,
      BreaticVideo,
      BreaticAudio,
      BreaticCodeBlock,
      SlashCommandExtension,
      HeadingFold,
      FormatBubbleSuppress,
    ],
    content: contentFromNode || '',
    autofocus: false,
    editable: true,
    onCreate: ({ editor: ed }) => {
      lastWrittenHtmlRef.current = ed.getHTML();
    },
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      lastWrittenHtmlRef.current = html;
      if (isApplyingRemoteRef.current) return;

      const cur = (nodesRef.current.find((x) => x.id === nodeId)?.data ?? {}) as Record<string, unknown>;
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
    },
  });

  useEffect(() => {
    if (!editor) return;
    const incoming = contentFromNode;
    if (incoming === lastWrittenHtmlRef.current) return;
    const curHtml = editor.getHTML();
    if (incoming === curHtml) {
      lastWrittenHtmlRef.current = incoming;
      return;
    }
    isApplyingRemoteRef.current = true;
    editor.commands.setContent(incoming, { emitUpdate: false });
    lastWrittenHtmlRef.current = editor.getHTML();
    queueMicrotask(() => {
      isApplyingRemoteRef.current = false;
    });
  }, [editor, contentFromNode]);

  useEffect(() => {
    return () => editor?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Dismiss slash UI when clicking outside ProseMirror (gutter / chrome).
   * `editor.view` is only valid after EditorContent mounts — defer attach with rAF + try/catch.
   */
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const wrap = editorWrapperRef.current;
    if (!wrap) return;

    let cancelled = false;
    let rafId = 0;
    let attempts = 0;
    const maxAttempts = 120;
    let listening = false;

    const onPointerDownCapture = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('[data-breatic-slash-menu]')) return;
      try {
        if (editor.isDestroyed) return;
        if (editor.view.dom.contains(t)) return;
      } catch {
        return;
      }
      try {
        if (!breaticSlashMenuKey.getState(editor.state)) return;
      } catch {
        return;
      }
      queueMicrotask(() => {
        try {
          if (!editor.isDestroyed) closeBreaticSlashMenu(editor.view);
        } catch {
          /* view torn down */
        }
      });
    };

    const tryAttach = () => {
      if (cancelled || listening || editor.isDestroyed) return;
      if (attempts++ > maxAttempts) return;
      try {
        if (!editor.view.dom) {
          rafId = requestAnimationFrame(tryAttach);
          return;
        }
      } catch {
        rafId = requestAnimationFrame(tryAttach);
        return;
      }
      wrap.addEventListener('pointerdown', onPointerDownCapture, true);
      listening = true;
    };

    tryAttach();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (listening) wrap.removeEventListener('pointerdown', onPointerDownCapture, true);
    };
  }, [editor]);

  return (
    <div className='flex h-full w-full overflow-hidden text-text-default-base'>
      {editor && <TableOfContents editor={editor} />}
      <div
        ref={editorWrapperRef}
        className='breatic-editor-wrapper relative flex-1 overflow-y-auto bg-background-default-secondary min-w-0'
      >
        <div className='breatic-editor-body relative px-[84px] pb-32 pt-12'>
          <EditorContent editor={editor} />
          {editor && <EditorMenus editor={editor} />}
          {editor && <BlockLineControl editor={editor} />}
        </div>
        <ImageFilePanel />
        <MediaFilePanel />
      </div>
    </div>
  );
};

export default TextEditor;
