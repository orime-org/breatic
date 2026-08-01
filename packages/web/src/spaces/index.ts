// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ComponentType } from 'react';

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
   * The collab connection cannot carry a mutation right now — it dropped, or
   * this document was refused. Space bodies must gate the same writes they gate
   * on `readOnly`: the product supports no offline editing at all (user,
   * 2026-07-29), so anything changed now goes into a local Y.Doc with nowhere
   * to send it.
   *
   * Separate from `readOnly` because the two have different causes and deserve
   * different explanations to the user, even though every mutating entry point
   * treats them identically.
   */
  writesBlocked?: boolean;
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
