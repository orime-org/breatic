import React, { useEffect, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { TextStyle, Color, BackgroundColor } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';
import { useProjectStore } from '@/hooks/useProjectStore';
import type { CanvasWorkflowNodeData } from '@/apps/project/components/canvas/types';
import EditorMenus from './components/EditorMenus';
import BlockLineControl from './components/BlockLineControl';
import './editor.css';

interface TextEditorProps {
  nodeId: string;
}

/**
 * Right panel editor: loads HTML from `node.data.content`, persists with `updateNode` (same fields as {@link TextNode}).
 */
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
  const isApplyingRemoteRef = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      BackgroundColor,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false }),
      Highlight.configure({ multicolor: false }),
      Placeholder.configure({ placeholder: "Write something, or '/' for commands…" }),
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

  // Canvas / other surfaces changed `data.content` while this panel stays open
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

  return (
    <div className='breatic-editor-wrapper relative h-full w-full overflow-y-auto bg-background-default-secondary text-text-default-base'>
      <div className='breatic-editor-body px-24 pb-[200px] pt-[72px]'>
        {/* EditorContent must mount first so ProseMirror `editor.view` exists for menus / block handle */}
        <EditorContent editor={editor} />
        {editor && <EditorMenus editor={editor} />}
        {/* Block drag-and-drop: grip on the line handle (BlockLineControl) moves top-level blocks */}
        {editor && <BlockLineControl editor={editor} />}
      </div>
    </div>
  );
};

interface TextEditorPanelProps {
  nodeId: string;
}

const TextEditorPanel = ({ nodeId }: TextEditorPanelProps) => <TextEditor key={nodeId} nodeId={nodeId} />;

export default TextEditorPanel;
