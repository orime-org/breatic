// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';
import { SPACE_TYPES, type SpaceType } from '@web/spaces';

interface SpaceOutletProps {
  projectId: string;
  spaceId: string;
  type: SpaceType;
  /** Read-only mode for the current user (viewer role), forwarded to the body. */
  readOnly?: boolean;
  /** Resolves collaborators' names from the roster, forwarded to the body. */
  collaboratorNames?: CollaboratorNames | null;
}

/**
 * Generic body renderer — looks up the active space's `bodyComponent`
 * from the `SPACE_TYPES` registry and renders it. New space types only
 * have to register themselves; this outlet does not need to change.
 * @param root0 - The component props.
 * @param root0.projectId - The id of the project the Space belongs to.
 * @param root0.spaceId - The id of the Space to render.
 * @param root0.type - The Space type used to resolve the body component.
 * @param root0.readOnly - Read-only mode for the current user, forwarded to the body.
 * @param root0.collaboratorNames - Resolves collaborators' names, forwarded to the body.
 * @returns The registered Space body, or an error message for an unknown type.
 */
export function SpaceOutlet({
  projectId,
  spaceId,
  type,
  readOnly,
  collaboratorNames,
}: SpaceOutletProps): React.JSX.Element {
  const def = SPACE_TYPES[type];
  if (!def) {
    return (
      <div
        data-testid='space-outlet-unknown'
        className='flex h-full w-full items-center justify-center text-sm text-status-error-foreground'
      >
        Unknown space type: {type}
      </div>
    );
  }
  const Body = def.bodyComponent;
  return (
    <Body
      projectId={projectId}
      spaceId={spaceId}
      readOnly={readOnly}
      collaboratorNames={collaboratorNames}
    />
  );
}
