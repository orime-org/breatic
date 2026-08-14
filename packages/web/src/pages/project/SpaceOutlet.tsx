// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { SpaceReadOnlyNotice } from '@web/pages/project/SpaceReadOnlyNotice';
import { SPACE_TYPES, type SpaceType } from '@web/spaces';

interface SpaceOutletProps {
  projectId: string;
  spaceId: string;
  type: SpaceType;
  /** Read-only mode for the current user (viewer role), forwarded to the body. */
  readOnly?: boolean;
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
 * @returns The registered Space body, or an error message for an unknown type.
 */
export function SpaceOutlet({
  projectId,
  spaceId,
  type,
  readOnly,
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
  // The read-only notice is anchored INSIDE the Space, so the wrapper owns the
  // positioning context. It sits here rather than in each Space body because
  // whether a connection may write is decided per document and every type has
  // to answer for its own — one place, and each type's body stays out of it.
  //
  // `readOnly` goes to BOTH: the body uses it to gate editing, and the notice
  // uses it to stay quiet for a viewer, whose read-only is their role rather
  // than something the server took away.
  //
  // A newly registered Space type is NOT covered by this alone — the notice
  // resolves a document name through `DOC_NAME_BUILDERS`, and a type missing
  // from that table renders nothing. Adding a type means both tables.
  return (
    <div className='relative h-full w-full'>
      <SpaceReadOnlyNotice
        projectId={projectId}
        spaceId={spaceId}
        type={type}
        readOnly={readOnly}
      />
      <Body
        projectId={projectId}
        spaceId={spaceId}
        readOnly={readOnly}
      />
    </div>
  );
}
