import type { CanvasNode, Modality } from '@/spaces/canvas/types/node';
import { getMiniTool } from '@/pages/project/mini-tool-system/catalog';

export interface ApplyMiniToolInput {
  sourceNode: Pick<CanvasNode, 'id' | 'position'>;
  toolId: string;
  /** Caller-supplied id generator (kept injectable for deterministic tests). */
  newId: () => string;
  /** Optional Y or db write hook — called once the new node + edge are built. */
  commit?: (mutation: ApplyMutation) => void;
}

export interface ApplyMutation {
  newNode: {
    id: string;
    position: { x: number; y: number };
    data: {
      kind: Modality;
      status: 'handling';
    };
  };
  edge: {
    id: string;
    source: string;
    target: string;
    /** Primary edge marks the tool-output relationship (vs `@`-reference). */
    kind: 'primary';
    toolId: string;
  };
}

/**
 * Unified Apply contract for every mini-tool — per ADR
 * mini-tool-unified-output. Given a source node + tool, produces:
 *   1. a NEW sibling node placed to the right (or below) of the source,
 *      with status `handling` (the worker fills the payload later);
 *   2. a primary edge from source → new node, tagged with the toolId.
 *
 * The source node is NEVER mutated. Callers compose this with the canvas
 * write adapter (Yjs nodes + edges maps) at the commit step.
 */
export function applyAsNewNode(input: ApplyMiniToolInput): ApplyMutation {
  const tool = getMiniTool(input.toolId);
  if (!tool) {
    throw new Error(`Unknown mini-tool: ${input.toolId}`);
  }
  const newNode = {
    id: input.newId(),
    position: {
      x: input.sourceNode.position.x + 320,
      y: input.sourceNode.position.y,
    },
    data: {
      kind: tool.output,
      status: 'handling' as const,
    },
  };
  const edge = {
    id: `${input.sourceNode.id}->${newNode.id}`,
    source: input.sourceNode.id,
    target: newNode.id,
    kind: 'primary' as const,
    toolId: tool.id,
  };
  const mutation: ApplyMutation = { newNode, edge };
  input.commit?.(mutation);
  return mutation;
}
