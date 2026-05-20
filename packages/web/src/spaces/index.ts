import type { ComponentType } from 'react';

import { CanvasSpace } from '@/spaces/canvas/CanvasSpace';
import { DocumentSpace } from '@/spaces/document/DocumentSpace';
import { TimelineSpace } from '@/spaces/timeline/TimelineSpace';

export type SpaceType = 'canvas' | 'document' | 'timeline';

export interface SpaceBodyProps {
  spaceId: string;
  projectId: string;
}

export interface SpaceDefinition {
  type: SpaceType;
  label: string;
  icon: string;
  bodyComponent: ComponentType<SpaceBodyProps>;
}

/**
 * Open enum of space implementations. Adding a space = add one entry here
 * + one folder under spaces/. The `SpaceOutlet` looks up the active space's
 * `bodyComponent` from this table at render time.
 *
 * Order is the recommended "new space" picker order in `NewSpaceDialog`.
 */
export const SPACE_TYPES: Record<SpaceType, SpaceDefinition> = {
  canvas: {
    type: 'canvas',
    label: 'Canvas',
    icon: 'layout-grid',
    bodyComponent: CanvasSpace,
  },
  document: {
    type: 'document',
    label: 'Document',
    icon: 'file-text',
    bodyComponent: DocumentSpace,
  },
  timeline: {
    type: 'timeline',
    label: 'Timeline',
    icon: 'film',
    bodyComponent: TimelineSpace,
  },
};

export const SPACE_TYPE_LIST: ReadonlyArray<SpaceDefinition> =
  Object.values(SPACE_TYPES);
