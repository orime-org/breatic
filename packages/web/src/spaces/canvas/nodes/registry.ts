import type { ComponentType } from 'react';

import type { NodeKind } from '@/spaces/canvas/types/node';
import { AnnotationNode } from './AnnotationNode';
import { AudioNode } from './AudioNode';
import { ImageNode } from './ImageNode';
import { TextNode } from './TextNode';
import { VideoNode } from './VideoNode';

/**
 * Maps `NodeKind` → React component used by the ReactFlow nodeTypes
 * prop. The annotation entry is wired even though the standalone node
 * lives in its own folder so the registry stays the single source of
 * truth for "what kinds can the canvas render."
 *
 * Adding a new modality (e.g. `3d`, `web`):
 *   1. Add a discriminated union member in types/node.ts
 *   2. Author the node component
 *   3. Add it to NODE_TYPES below
 */
export const NODE_TYPES: Record<NodeKind, ComponentType<{ data: unknown }>> = {
  text: TextNode as ComponentType<{ data: unknown }>,
  image: ImageNode as ComponentType<{ data: unknown }>,
  audio: AudioNode as ComponentType<{ data: unknown }>,
  video: VideoNode as ComponentType<{ data: unknown }>,
  annotation: AnnotationNode as ComponentType<{ data: unknown }>,
};

export const NODE_KIND_LIST: ReadonlyArray<NodeKind> = [
  'text',
  'image',
  'audio',
  'video',
  'annotation',
];
