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
 * Doc-name builder per Space type. A type absent from this table has no Yjs
 * document yet, and attaching is skipped for it — adding one later is a single
 * entry here rather than another branch in the component.
 *
 * The doc NAME carries the Space kind, so a canvas and a document Space that
 * happen to share an id still resolve to two separate documents.
 */
const DOC_NAME_BUILDERS: Partial<
  Record<SpaceType, (projectId: string, spaceId: string) => string>
> = {
  canvas: docName.canvasSpace,
  document: docName.documentSpace,
};

/**
 * Keep one Space's Yjs document attached to the shared collab socket for as
 * long as this component is mounted. Renders nothing.
 *
 * Mounted once per OPEN tab (keyed on the Space id), so the document attaches
 * when the tab opens and detaches when it CLOSES — independent of which tab is
 * currently active / rendered. Switching the active tab leaves every open tab's
 * document attached (the open-tab list is unchanged), so background tabs stay
 * live and re-activating one is instant (no re-handshake). See the
 * shared-WebSocket design (2026-06-18).
 * @param root0 - Attachment props.
 * @param root0.name - Canonical document name to keep attached.
 * @returns Nothing — this component only manages the document attachment.
 */
function SpaceDocAttach({ name }: { name: string }): null {
  const doc = React.useMemo(() => getDoc(name), [name]);
  useSocket({ name, doc });
  return null;
}

/**
 * Attach an open Space tab's Yjs document to the shared collab socket. Canvas
 * and document Spaces each have their own document; timeline has none yet, so
 * this is a no-op for it until it gains one.
 *
 * Rendered once per open tab so attach / detach follows tab OPEN / CLOSE, not
 * the active selection (user requirement, 2026-06-18).
 * @param root0 - Attachment props.
 * @param root0.projectId - Project the Space belongs to.
 * @param root0.spaceId - Space whose document to keep attached while its tab is open.
 * @param root0.type - Space type; decides which document name to attach, if any.
 * @returns The document attachment, or null for Space types without a document.
 */
export function SpaceDocSync({
  projectId,
  spaceId,
  type,
}: SpaceDocSyncProps): React.JSX.Element | null {
  const buildName = DOC_NAME_BUILDERS[type];
  if (!buildName) return null;
  return <SpaceDocAttach name={buildName(projectId, spaceId)} />;
}
