/**
 * GenerativeNode (spec §10.13 v13) — fixed 480×320 three-segment shell.
 *
 * Layout (top to bottom):
 *   [60px]  Reference rail   — chip strip + [+] button; chips are derived
 *                              from incoming edges, not from a Yjs field.
 *   [200px] Prompt area      — textarea mockup. The full Tiptap editor with
 *                              inline-atom chips is owned by F12; F2 stops at
 *                              a local-only textarea (intentionally NOT
 *                              persisted — prompt persistence ships with F12).
 *   [60px]  Pill bar         — kind dropdown / model stub / credit stub /
 *                              ▶ 新增版本 / ↻ 更新. The two execute buttons
 *                              are visual-only here; their onClick logic
 *                              (atomic create, primary-edge bookkeeping,
 *                              POST /tasks) is owned by F3.
 *
 * Out of scope for F2 (handled by referenced tasks):
 *   - References Y.Array persistence + edge↔refs sync .................. F3
 *   - Atomic three-body create (generative + asset + primary edge) ..... F3
 *   - POST /api/tasks on click ......................................... F3
 *   - Tiptap inline-atom chip editor + Y.XmlFragment write-through ..... F12
 *   - Primary edge visual (brand colour + animated arrow) .............. F10
 */
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { type NodeProps, Position } from '@xyflow/react';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import NodeHeader from '../../common/NodeHeader';
import DataNodeHandle from '../../common/DataNodeHandle';
import type { CanvasWorkflowNodeData } from '@/spaces/canvas/types';

const GENERATIVE_NODE_WIDTH = 480;
const GENERATIVE_NODE_HEIGHT = 320;
const REFERENCE_RAIL_HEIGHT = 60;
const PILL_BAR_HEIGHT = 60;

type GenerativeOutputType = 'text' | 'image' | 'video' | 'audio';

/**
 * Per-{@link GenerativeOutputType} sub-task variants (spec §10.13.1 v13).
 * `text` and `video` have a single kind today; the dropdown hides when
 * the option list has length 1 so the pill bar stays compact.
 */
const KIND_OPTIONS: Record<GenerativeOutputType, readonly string[]> = {
  image: ['文生图', '图生图'],
  audio: ['music', 'tts', '旋律', '环境音'],
  video: ['video'],
  text: ['text'],
};

const targetHandleId = 'Generative_0_0';
const sourceHandleId = 'Generative_0_0';

interface DerivedReference {
  edgeId: string;
  sourceNodeId: string;
  name: string;
  thumbnail?: string;
}

const GenerativeNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const { nodes, edges } = useCanvasData();
  const { updateNode, onEdgesChange } = useCanvasActions();
  const wf = data as Partial<CanvasWorkflowNodeData> | undefined;

  const outputType = (wf?.outputType ?? 'image') as GenerativeOutputType;
  const kindOptions = KIND_OPTIONS[outputType] ?? [];
  const kind = wf?.kind ?? kindOptions[0] ?? '';

  // F2 derives the rail directly from incoming edges + upstream lookup.
  // F3 will replace this with a Yjs `references` Y.Array (stable order +
  // addedAt timestamps), but the visual contract — one chip per incoming
  // edge — stays the same.
  const incomingRefs: DerivedReference[] = useMemo(() => {
    const out: DerivedReference[] = [];
    for (const edge of edges) {
      if (edge.target !== id) continue;
      const upstream = nodes.find((n) => n.id === edge.source);
      if (!upstream) continue;
      const upstreamData = upstream.data as Partial<CanvasWorkflowNodeData> | undefined;
      out.push({
        edgeId: edge.id,
        sourceNodeId: upstream.id,
        name: upstreamData?.name || upstream.id,
        thumbnail: upstreamData?.cover_url || upstreamData?.content,
      });
    }
    return out;
  }, [edges, nodes, id]);

  // Local prompt state. NOT persisted — F12 lands the Tiptap editor
  // wired to the `prompt` Y.XmlFragment that createGenerativeNode
  // already initializes. Until then this textarea is a visual stub
  // for laying out the three-segment shell.
  const [promptText, setPromptText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Mockup picker: clicking a chip in the rail inserts `@name ` at
   * the textarea cursor. The full @-trigger keyboard flow ships with
   * the Tiptap editor in F12; here we accept a tap-driven equivalent
   * because it exercises the same data flow (rail → prompt) without
   * pulling in keystroke handling.
   */
  const insertReferenceAtCursor = useCallback(
    (name: string) => {
      const ta = textareaRef.current;
      if (!ta) {
        setPromptText((prev) => `${prev}@${name} `);
        return;
      }
      const start = ta.selectionStart ?? promptText.length;
      const end = ta.selectionEnd ?? promptText.length;
      const insertion = `@${name} `;
      const next = promptText.slice(0, start) + insertion + promptText.slice(end);
      setPromptText(next);
      // Restore caret to right after the inserted mention.
      requestAnimationFrame(() => {
        ta.focus();
        const caret = start + insertion.length;
        ta.setSelectionRange(caret, caret);
      });
    },
    [promptText],
  );

  const handleRemoveReference = useCallback(
    (edgeId: string) => {
      onEdgesChange([{ type: 'remove', id: edgeId }]);
    },
    [onEdgesChange],
  );

  const handleAddReferenceClick = useCallback(() => {
    // F3 wires "pick a node from canvas" mode here.
  }, []);

  const handleKindChange = useCallback(
    (newKind: string) => {
      updateNode(id, { data: { kind: newKind } });
    },
    [id, updateNode],
  );

  const handleNewVersionClick = useCallback(() => {
    // F3: POST /api/tasks { mode: 'append', targetId: <new sibling> }.
  }, []);

  const handleUpdatePrimaryClick = useCallback(() => {
    // F3: POST /api/tasks { mode: 'overwrite', targetId: <primary downstream> }.
  }, []);

  const isPromptEmpty = promptText.trim().length === 0;

  return (
    <>
      <div className='absolute -translate-y-full text-left left-0 -top-0 text-foreground/60 overflow-hidden text-ellipsis whitespace-nowrap'>
        <NodeHeader nodeId={id} title='Generative' editable={true} />
      </div>
      <div
        className={
          'relative flex flex-col rounded-[8px] bg-background-default-base outline outline-2 pointer-events-auto ' +
          (selected ? 'outline-solid outline-border-utilities-selected' : 'outline-transparent')
        }
        style={{ width: GENERATIVE_NODE_WIDTH, height: GENERATIVE_NODE_HEIGHT }}
      >
        <DataNodeHandle
          type='target'
          position={Position.Left}
          handleId={targetHandleId}
          nodeId={id}
          selected={selected}
          nodeHovered={false}
          isInsideLockedGroup={false}
        />
        <DataNodeHandle
          type='source'
          position={Position.Right}
          handleId={sourceHandleId}
          nodeId={id}
          selected={selected}
          nodeHovered={false}
          isInsideLockedGroup={false}
        />

        {/* ── Reference rail (60px) ─────────────────────────────────── */}
        <div
          className='flex items-center gap-2 px-3 border-b border-border-default-secondary overflow-x-auto'
          style={{ height: REFERENCE_RAIL_HEIGHT }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type='button'
            className='shrink-0 w-9 h-9 rounded-md border border-border-default-secondary flex items-center justify-center text-text-default-tertiary hover:bg-background-default-secondary'
            onClick={handleAddReferenceClick}
            title='Add reference (F3)'
          >
            +
          </button>
          {incomingRefs.length === 0 ? (
            <span className='text-[12px] text-text-default-tertiary'>
              No references — drag an edge into the left handle
            </span>
          ) : (
            incomingRefs.map((ref) => (
              <div
                key={ref.edgeId}
                className='shrink-0 group relative flex items-center gap-1.5 px-2 h-9 rounded-md bg-background-default-secondary cursor-pointer hover:bg-background-default-base-hover'
                onClick={() => insertReferenceAtCursor(ref.name)}
                title={`Insert @${ref.name} into prompt`}
              >
                {ref.thumbnail && /^(https?:|data:)/i.test(ref.thumbnail) ? (
                  <img src={ref.thumbnail} alt='' className='w-5 h-5 rounded object-cover' />
                ) : (
                  <span className='w-5 h-5 rounded bg-background-default-base flex items-center justify-center text-[10px]'>
                    •
                  </span>
                )}
                <span className='text-[12px] truncate max-w-[100px]'>{ref.name}</span>
                <button
                  type='button'
                  className='opacity-0 group-hover:opacity-100 ml-1 w-4 h-4 rounded-full text-[10px] flex items-center justify-center hover:bg-background-default-base'
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveReference(ref.edgeId);
                  }}
                  title='Remove reference'
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        {/* ── Prompt area (flex) ────────────────────────────────────── */}
        <div
          className='flex-1 px-3 py-2 nodrag'
          onMouseDown={(e) => e.stopPropagation()}
        >
          <textarea
            ref={textareaRef}
            className='w-full h-full resize-none border-0 outline-none bg-transparent text-[14px] text-text-default-primary placeholder:text-text-default-tertiary'
            placeholder='Describe what you want… click a reference chip to insert @mention'
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
          />
        </div>

        {/* ── Pill bar (60px) ───────────────────────────────────────── */}
        <div
          className='flex items-center gap-2 px-3 border-t border-border-default-secondary'
          style={{ height: PILL_BAR_HEIGHT }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {kindOptions.length > 1 && (
            <select
              className='h-7 px-2 rounded-md border border-border-default-secondary bg-background-default-base text-[12px]'
              value={kind}
              onChange={(e) => handleKindChange(e.target.value)}
            >
              {kindOptions.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          )}
          <div className='h-7 px-2 rounded-md border border-border-default-secondary bg-background-default-base text-[12px] flex items-center text-text-default-tertiary'>
            ⚙ {wf?.model || 'model'}
          </div>
          <div className='text-[12px] text-text-default-tertiary'>★ 0</div>
          <div className='flex-1' />
          <button
            type='button'
            className='h-7 px-3 rounded-md text-[12px] border border-border-default-secondary bg-background-default-base hover:bg-background-default-secondary disabled:opacity-50 disabled:cursor-not-allowed'
            disabled={isPromptEmpty}
            onClick={handleNewVersionClick}
            title={isPromptEmpty ? 'Enter a prompt first' : 'Create new sibling version (F3)'}
          >
            ▶ 新增版本
          </button>
          <button
            type='button'
            className='h-7 px-3 rounded-md text-[12px] bg-background-default-secondary text-text-default-primary hover:bg-background-default-base-hover disabled:opacity-50 disabled:cursor-not-allowed'
            disabled={isPromptEmpty}
            onClick={handleUpdatePrimaryClick}
            title={isPromptEmpty ? 'Enter a prompt first' : 'Update primary downstream (F3)'}
          >
            ↻ 更新
          </button>
        </div>
      </div>
    </>
  );
};

export default memo(GenerativeNode);
