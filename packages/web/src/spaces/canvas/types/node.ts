/**
 * Canvas node model — unified type nodes (2026-05-19).
 *
 * One node per modality:
 *   text · image · audio · video           (asset / generator distinction dropped)
 *   annotation (standalone, collaboration sticky)
 *
 * Generation behaviour now lives in the node toolbar's left zone
 * (generate / load) and modifies the active node in place; mini-tools
 * (right zone) create a new sibling node + primary edge.
 *
 * `@`-references are an edge relation + snapshot copy — there is NO
 * standalone ReferenceNode (chips are rendered by `reference-chips/`
 * atoms, driven by edges).
 */

export type Modality = 'text' | 'image' | 'audio' | 'video';

export type NodeKind = Modality | 'annotation';

/** Visible state of a node body (drives placeholder vs content vs spinner). */
export type NodeStatus = 'idle' | 'handling' | 'error';

export interface NodeBase {
  id: string;
  kind: NodeKind;
  /** ReactFlow position. Frontend-owned (back end never writes this). */
  position: { x: number; y: number };
}

export interface TextNodeData {
  kind: 'text';
  content: string;
  status: NodeStatus;
  errorMessage?: string;
}

export interface ImageNodeData {
  kind: 'image';
  url?: string;
  status: NodeStatus;
  errorMessage?: string;
}

export interface AudioNodeData {
  kind: 'audio';
  url?: string;
  durationMs?: number;
  status: NodeStatus;
  errorMessage?: string;
}

export interface VideoNodeData {
  kind: 'video';
  url?: string;
  coverUrl?: string;
  durationMs?: number;
  status: NodeStatus;
  errorMessage?: string;
}

export interface AnnotationNodeData {
  kind: 'annotation';
  text: string;
  authorId: string;
  createdAt: string;
}

export type NodeData =
  | TextNodeData
  | ImageNodeData
  | AudioNodeData
  | VideoNodeData
  | AnnotationNodeData;

export interface CanvasNode extends NodeBase {
  data: NodeData;
}

/**
 * True if the modality is one of the 4 type nodes that own a content
 * payload (excludes annotation which is collaboration-only).
 */
export function isContentNode(
  data: NodeData,
): data is TextNodeData | ImageNodeData | AudioNodeData | VideoNodeData {
  return data.kind !== 'annotation';
}
