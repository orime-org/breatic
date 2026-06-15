// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ComponentType } from 'react';

import type { NodeKind } from '@web/spaces/canvas/types/node-view';

/**
 * Common prop surface every canvas node component accepts. The body is
 * passed the narrowed `data` view at runtime (cast per kind); `selected`
 * / `locked` are supplied by the ReactFlow wrapper.
 */
type CanvasNodeComponent = ComponentType<{
  data: unknown;
  selected?: boolean;
  locked?: boolean;
}>;
import { AnnotationNode } from '@web/spaces/canvas/nodes/AnnotationNode';
import { AudioNode } from '@web/spaces/canvas/nodes/AudioNode';
import { ImageNode } from '@web/spaces/canvas/nodes/ImageNode';
import { TextNode } from '@web/spaces/canvas/nodes/TextNode';
import { ThreeDNode } from '@web/spaces/canvas/nodes/ThreeDNode';
import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';
import { WebNode } from '@web/spaces/canvas/nodes/WebNode';

/**
 * Maps `NodeKind` → React component used by the ReactFlow `nodeTypes`
 * prop. The annotation entry is wired even though the standalone node
 * lives in its own folder so the registry stays the single source of
 * truth for "what kinds can the canvas render."
 *
 * Adding a new modality:
 *   1. Add a discriminated union member in types/node-view.ts
 *   2. Author the node component
 *   3. Add it to NODE_TYPES below
 */
export const NODE_TYPES: Record<NodeKind, CanvasNodeComponent> = {
  text: TextNode as CanvasNodeComponent,
  image: ImageNode as CanvasNodeComponent,
  audio: AudioNode as CanvasNodeComponent,
  video: VideoNode as CanvasNodeComponent,
  '3d': ThreeDNode as CanvasNodeComponent,
  web: WebNode as CanvasNodeComponent,
  annotation: AnnotationNode as CanvasNodeComponent,
};

export const NODE_KIND_LIST: ReadonlyArray<NodeKind> = [
  'text',
  'image',
  'audio',
  'video',
  '3d',
  'web',
  'annotation',
];
