/**
 * NodeFloatMenu — small floating button strip that appears above a
 * selected asset node (spec mockup `05-canvas-native-tailwind.html`).
 *
 * The host (ImageNode / VideoNode / AudioNode) renders this inside a
 * ReactFlow `<NodeToolbar>` slot when the node is selected. Clicking
 * a tool sets the active tool on {@link MiniToolContext}; the canvas
 * root's BottomToolbar then renders the matching parameter UI.
 *
 * Schema-driven: the host passes `tools` (e.g. `IMAGE_TOOLS` from
 * `tool-schemas.ts`); adding a tool to the schema adds a button here
 * with no menu changes needed.
 */
import { useMiniTool } from './MiniToolContext';
import type { ToolSchema } from './types';

interface NodeFloatMenuProps {
  /** The asset node this menu is anchored to. */
  nodeId: string;
  /** Tools to surface — usually `IMAGE_TOOLS` / `VIDEO_TOOLS` / `AUDIO_TOOLS`. */
  tools: ReadonlyArray<ToolSchema>;
}

export function NodeFloatMenu({ nodeId, tools }: NodeFloatMenuProps) {
  const { active, pickTool } = useMiniTool();
  const activeToolForThisNode =
    active && active.nodeId === nodeId ? active.toolId : null;

  return (
    <div
      className='flex gap-0.5 bg-neutral-900 p-1 rounded-md shadow-md pointer-events-auto'
      onMouseDown={(e) => e.stopPropagation()}
    >
      {tools.map((t) => (
        <button
          key={t.id}
          type='button'
          onClick={(e) => {
            e.stopPropagation();
            pickTool(nodeId, t.id);
          }}
          title={t.title + (t.category === 'A' ? ' (前端,F4-A 接通)' : '')}
          className={
            'h-[26px] px-2.5 text-xs rounded-sm transition-colors flex items-center gap-1 ' +
            (activeToolForThisNode === t.id
              ? 'bg-brand-500 text-white'
              : 'bg-transparent text-neutral-100 hover:bg-white/12 hover:text-white')
          }
        >
          {t.menuLabel}
        </button>
      ))}
    </div>
  );
}
