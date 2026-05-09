/**
 * PromptEditor — Tiptap rich-text editor bound to a node's
 * Y.XmlFragment (spec §10.13.1 v13).
 *
 * Renders inside GenerativeNode's middle segment. Keystrokes flow
 * through the @tiptap/extension-collaboration plugin into the bound
 * Y.XmlFragment, which is stored in the canvas Yjs doc and synced to
 * collaborators in real time. Chips are atom nodes carrying a frozen
 * ChipSnapshot (spec §10.13.2) — independent of the upstream node
 * after capture.
 *
 * Lifecycle:
 *   - mounts when GenerativeNode mounts; tears down on unmount
 *   - while the editor is mounted, focus + edit + blur are all
 *     persistent (collaboration auto-syncs); spec's "Cmd+Enter
 *     saves" semantics is a no-op for persistence — keystrokes are
 *     already saved. We still wire `onCmdEnter` so the parent
 *     (GenerativeNode F3) can use it as a "submit" trigger.
 *   - Esc blurs the editor (so ReactFlow regains focus for canvas hotkeys)
 */
import * as Y from 'yjs';
import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { useActiveCanvasSpace } from '@/domain/space/ActiveCanvasSpaceContext';
import { Chip } from './ChipNode';
import { buildMentionSuggestion, type ReferenceSuggestionItem } from './use-mention-suggestion';

interface PromptEditorProps {
  nodeId: string;
  /**
   * Live list of references (mirrors incoming edges + upstream lookup).
   * Stored on a ref internally so the suggestion plugin always sees
   * the latest list without rebuilding the editor on every edge
   * change.
   */
  references: ReferenceSuggestionItem[];
  /** Called when the user presses Cmd+Enter / Ctrl+Enter inside the editor. */
  onCmdEnter?: () => void;
  /**
   * Notified whenever the editor's empty state flips. Parent uses this
   * to disable the Generate buttons when the prompt is empty
   * (spec §10.13.4 v13).
   */
  onEmptyChange?: (isEmpty: boolean) => void;
  /** Placeholder text when the editor is empty. */
  placeholder?: string;
}

/**
 * Read the prompt Y.XmlFragment off the active canvas Space's
 * `nodesMap[nodeId].data.prompt`. Returns null when the manager isn't
 * synced yet or the node hasn't been written — caller renders a
 * disabled placeholder in that case.
 */
function readPromptFragment(
  mgr: ReturnType<typeof useActiveCanvasSpace>,
  nodeId: string,
): Y.XmlFragment | null {
  if (!mgr?.synced) return null;
  const nodeMap = mgr.nodesMap.get(nodeId);
  if (!(nodeMap instanceof Y.Map)) return null;
  const dataMap = nodeMap.get('data');
  if (!(dataMap instanceof Y.Map)) return null;
  const fragment = dataMap.get('prompt');
  return fragment instanceof Y.XmlFragment ? fragment : null;
}

export function PromptEditor({
  nodeId,
  references,
  onCmdEnter,
  onEmptyChange,
  placeholder,
}: PromptEditorProps) {
  const mgr = useActiveCanvasSpace();
  const fragment = useMemo(() => readPromptFragment(mgr, nodeId), [mgr, nodeId]);

  // Keep references on a ref so the suggestion closure picks up updates
  // without rebuilding the whole editor (which would lose focus + the
  // user's Tiptap selection state on every edge change).
  const referencesRef = useRef(references);
  referencesRef.current = references;

  const onCmdEnterRef = useRef(onCmdEnter);
  onCmdEnterRef.current = onCmdEnter;

  const onEmptyChangeRef = useRef(onEmptyChange);
  onEmptyChangeRef.current = onEmptyChange;

  const editor = useEditor(
    {
      extensions: fragment
        ? [
            // Collaboration owns history (the doc-level Y.UndoManager);
            // disabling StarterKit's undoRedo (Tiptap v3 renamed
            // `history` → `undoRedo`) avoids two undo stacks fighting.
            StarterKit.configure({ undoRedo: false }),
            Collaboration.configure({ fragment }),
            Chip.configure({
              suggestion: buildMentionSuggestion({
                getReferences: () => referencesRef.current,
              }),
            }),
          ]
        : [],
      // Don't auto-focus on mount — the user double-clicks to edit.
      autofocus: false,
      onCreate: ({ editor: e }) => {
        onEmptyChangeRef.current?.(e.isEmpty);
      },
      onUpdate: ({ editor: e }) => {
        onEmptyChangeRef.current?.(e.isEmpty);
      },
      editorProps: {
        attributes: {
          class:
            'prompt-editor-content w-full h-full outline-none text-[14px] text-text-default-primary [&_.is-editor-empty]:before:content-[attr(data-placeholder)] [&_.is-editor-empty]:before:text-text-default-tertiary [&_.is-editor-empty]:before:pointer-events-none [&_.is-editor-empty]:before:float-left [&_.is-editor-empty]:before:h-0',
          'data-placeholder': placeholder ?? '',
        },
        handleKeyDown(_view, event) {
          const isCmdEnter =
            event.key === 'Enter' && (event.metaKey || event.ctrlKey);
          if (isCmdEnter) {
            event.preventDefault();
            onCmdEnterRef.current?.();
            return true;
          }
          if (event.key === 'Escape') {
            // Blur so canvas hotkeys (Delete / arrows) work again.
            event.preventDefault();
            (event.target as HTMLElement)?.blur?.();
            return true;
          }
          return false;
        },
      },
    },
    // Rebuild only when fragment changes (node id changes / Yjs becomes
    // synced). references updates flow through the ref above.
    [fragment],
  );

  // Tear down on unmount — Tiptap's useEditor handles this for us, but
  // double-check the editor is actually destroyed when the GenerativeNode
  // unmounts (e.g. user deletes the node mid-edit).
  useEffect(() => {
    return () => {
      editor?.destroy();
    };
  }, [editor]);

  if (!fragment) {
    return (
      <div className='w-full h-full text-[14px] text-text-default-tertiary p-1'>
        {placeholder ?? '...'}
      </div>
    );
  }

  return <EditorContent editor={editor} className='w-full h-full' />;
}
