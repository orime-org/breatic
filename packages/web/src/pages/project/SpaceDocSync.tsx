// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { docName, getDoc } from '@web/data/yjs/manager';
import { useSocket } from '@web/data/yjs/use-socket';
import type { SpaceType } from '@web/spaces';

interface SpaceDocSyncProps {
  projectId: string;
  spaceId: string;
  type: SpaceType;
}

/**
 * Keep a single canvas Space's Yjs document attached to the shared collab
 * socket for as long as this component is mounted. Renders nothing.
 *
 * Mounted once per OPEN tab (keyed on the Space id), so the document attaches
 * when the tab opens and detaches when it CLOSES — independent of which tab is
 * currently active / rendered. Switching the active tab leaves every open tab's
 * document attached (the open-tab list is unchanged), so background tabs stay
 * live and re-activating one is instant (no re-handshake). See the
 * shared-WebSocket design (2026-06-18).
 * @param root0 - Attachment props.
 * @param root0.projectId - Project the Space belongs to.
 * @param root0.spaceId - Canvas Space whose document to keep attached.
 * @returns Nothing — this component only manages the document attachment.
 */
function CanvasDocAttach({
  projectId,
  spaceId,
}: {
  projectId: string;
  spaceId: string;
}): null {
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = React.useMemo(() => getDoc(name), [name]);
  useSocket({ name, doc });
  return null;
}

/**
 * Attach an open Space tab's Yjs document to the shared collab socket. Only
 * canvas Spaces have a document binding today; document / timeline Spaces have
 * no Yjs doc yet, so this is a no-op for them (extend when those gain docs).
 *
 * Rendered once per open tab so attach / detach follows tab OPEN / CLOSE, not
 * the active selection (user requirement, 2026-06-18).
 * @param root0 - Attachment props.
 * @param root0.projectId - Project the Space belongs to.
 * @param root0.spaceId - Space whose document to keep attached while its tab is open.
 * @param root0.type - Space type; only `canvas` has a document to attach today.
 * @returns The canvas document attachment, or null for non-canvas Spaces.
 */
export function SpaceDocSync({
  projectId,
  spaceId,
  type,
}: SpaceDocSyncProps): React.JSX.Element | null {
  if (type === 'canvas') {
    return <CanvasDocAttach projectId={projectId} spaceId={spaceId} />;
  }
  return null;
}
