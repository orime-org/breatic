// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ComponentType } from 'react';

import type { NodeType } from '@breatic/shared';

/**
 * Common prop surface every canvas node component accepts. The body is
 * passed the narrowed `data` view at runtime (cast per type); `selected`
 * / `locked` / `onRename` are supplied by the ReactFlow wrapper (the wrapper
 * pre-binds `onRename` to this node's id; content nodes use it, annotation /
 * group ignore it).
 */
type CanvasNodeComponent = ComponentType<{
  data: unknown;
  selected?: boolean;
  locked?: boolean;
  onRename?: (name: string) => void;
}>;
import { AnnotationNode } from '@web/spaces/canvas/nodes/AnnotationNode';
import { AudioNode } from '@web/spaces/canvas/nodes/AudioNode';
import { GroupNode } from '@web/spaces/canvas/nodes/GroupNode';
import { ImageNode } from '@web/spaces/canvas/nodes/ImageNode';
import { TextNode } from '@web/spaces/canvas/nodes/TextNode';
import { ThreeDNode } from '@web/spaces/canvas/nodes/ThreeDNode';
import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';
import { WebNode } from '@web/spaces/canvas/nodes/WebNode';

/**
 * Maps `NodeType` → React component used by the ReactFlow `nodeTypes`
 * prop. The annotation entry is wired even though the standalone node
 * lives in its own folder so the registry stays the single source of
 * truth for "what types can the canvas render."
 *
 * Adding a new modality:
 *   1. Add the view and its `NodeViewOf` entry in data/yjs/node-view.ts
 *   2. Author the node component
 *   3. Add it to NODE_TYPES below
 */
export const NODE_TYPES: Record<NodeType, CanvasNodeComponent> = {
  text: TextNode as CanvasNodeComponent,
  image: ImageNode as CanvasNodeComponent,
  audio: AudioNode as CanvasNodeComponent,
  video: VideoNode as CanvasNodeComponent,
  '3d': ThreeDNode as CanvasNodeComponent,
  web: WebNode as CanvasNodeComponent,
  annotation: AnnotationNode as CanvasNodeComponent,
  group: GroupNode as CanvasNodeComponent,
};

/** Every node type the canvas renders, in `NODE_TYPES` order. */
export const NODE_TYPE_LIST = Object.keys(NODE_TYPES) as ReadonlyArray<NodeType>;
