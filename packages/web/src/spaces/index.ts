// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ComponentType } from 'react';

import type { ProjectRole, SpaceType } from '@breatic/shared';

import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { DocumentSpace } from '@web/spaces/document/DocumentSpace';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';

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
   * The current user's role on the project, threaded through `SpaceOutlet`
   * beside `readOnly`.
   *
   * `readOnly` answers "may this person write at all", which is the question
   * most gates ask. Deleting an annotation asks a second one — whether they
   * own the project, since an owner may remove words they did not write
   * (#1881) — and `readOnly` cannot answer it. Defaults to the most
   * restrictive reading when omitted, the same fail-safe `ProjectPage` uses
   * when the project query has not answered yet.
   */
  myRole?: ProjectRole;
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
