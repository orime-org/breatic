// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { ProjectRole, SpaceType } from '@breatic/shared';

import { getDoc } from '@web/data/yjs/manager';
import {
  DOC_NAME_BUILDERS,
  SpaceConnectionContext,
} from '@web/data/yjs/space-connection';
import { useSocket } from '@web/data/yjs/use-socket';
import { SpaceOutlet } from '@web/pages/project/SpaceOutlet';
import { DocumentInterceptGuard } from '@web/spaces/document/document-intercept-guard';

interface OpenSpaceProps {
  projectId: string;
  spaceId: string;
  type: SpaceType;
  /** Whether this is the tab on screen. */
  active: boolean;
  /** Whether this tab has been on screen since it was opened. */
  visited: boolean;
  /** Read-only mode for the current user; goes to the body. */
  readOnly?: boolean;
  /** The current user's role on the project; goes to the body. */
  myRole?: ProjectRole;
}

/**
 * Hold one Space document's connection on the shared collab socket for as
 * long as the tab is open, and hand it to everything rendered inside.
 * @param root0 - Connection props.
 * @param root0.name - Canonical document name to keep attached.
 * @param root0.children - What reads the connection.
 * @returns The children inside the connection context.
 */
export function SpaceConnection({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const doc = React.useMemo(() => getDoc(name), [name]);
  const { provider, synced, hasEverSynced, status, writeAccess, authFailedReason } =
    useSocket({ name, doc });
  const connection = React.useMemo(
    () => ({ provider, synced, hasEverSynced, status, writeAccess, authFailedReason }),
    [provider, synced, hasEverSynced, status, writeAccess, authFailedReason],
  );
  return (
    <SpaceConnectionContext.Provider value={connection}>
      {children}
    </SpaceConnectionContext.Provider>
  );
}

/**
 * One open Space tab (inner#1235 §5.1).
 *
 * The tab holds its document's connection from open to close, whichever tab is
 * on screen, so a background tab stays live. Its body mounts the first time
 * the tab is on screen and from then on is hidden rather than unmounted when
 * the reader switches away, so it comes back as it was left; closing the tab
 * unmounts it.
 *
 * Memoized: its props are all plain values, and the project page re-renders on
 * every zoom step of the canvas on screen; a hidden body would be rendered
 * again each time.
 * @param root0 - Tab props.
 * @param root0.projectId - Project the Space belongs to.
 * @param root0.spaceId - The Space.
 * @param root0.type - Space type; decides the document and the body.
 * @param root0.active - Whether this is the tab on screen.
 * @param root0.visited - Whether this tab has been on screen since it opened.
 * @param root0.readOnly - Read-only mode for the current user.
 * @param root0.myRole - The current user's role on the project.
 * @returns The tab's connection and, once visited, its body.
 */
export const OpenSpace = React.memo(function OpenSpace({
  projectId,
  spaceId,
  type,
  active,
  visited,
  readOnly,
  myRole,
}: OpenSpaceProps): React.JSX.Element | null {
  const body = visited ? (
    <React.Activity mode={active ? 'visible' : 'hidden'}>
      <SpaceOutlet
        projectId={projectId}
        spaceId={spaceId}
        type={type}
        readOnly={readOnly}
        myRole={myRole}
      />
    </React.Activity>
  ) : null;
  const buildName = DOC_NAME_BUILDERS[type];
  if (!buildName) return body;
  return (
    <SpaceConnection name={buildName(projectId, spaceId)}>
      {/* A document Space's editor outlives its body's mount, so what shuts it
        down is mounted with the tab — see `DocumentInterceptGuard`. */}
      {type === 'document' ? (
        <DocumentInterceptGuard projectId={projectId} spaceId={spaceId} />
      ) : null}
      {body}
    </SpaceConnection>
  );
});
