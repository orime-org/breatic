// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ComponentType } from 'react';

import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';

import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { DocumentSpace } from '@web/spaces/document/DocumentSpace';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';

export type SpaceType = 'canvas' | 'document' | 'timeline';

export interface SpaceBodyProps {
  spaceId: string;
  projectId: string;
  /**
   * Read-only mode for the current user (viewer role). Sourced from the
   * project's `myRole` and threaded through `SpaceOutlet` — space bodies gate
   * their writes on it (e.g. the canvas blocks node creation). Defaults to
   * editable when omitted.
   */
  readOnly?: boolean;
  /**
   * Resolves collaborators' display names from the project member roster
   * (#1882), threaded through `SpaceOutlet` the same way `readOnly` is.
   *
   * It comes from above rather than being fetched here on purpose: the
   * project page already holds that roster for the member stack, so asking
   * for it again would be a second copy of one fact — and it would make every
   * space body depend on a QueryClientProvider that only the running app has.
   * Omitted, remote carets render as bare colour lines.
   */
  collaboratorNames?: CollaboratorNames | null;
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
