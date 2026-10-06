// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * An open Space tab's connection to its document (inner#1235 §5.1).
 *
 * The tab holds it for as long as it is open. A Space body is hidden rather
 * than unmounted when the reader switches away, and hiding cleans up the
 * body's effects; a connection held by the body would be released and read as
 * "connecting" again on the way back. Read from the tab, it stays as it was.
 */

import * as React from 'react';

import type { SpaceType } from '@breatic/shared';

import { docName } from '@web/data/yjs/manager';
import type { SocketState } from '@web/data/yjs/use-socket';

/** What a component outside an open tab with a document reads: not connected yet. */
const NOT_CONNECTED: SocketState = {
  provider: null,
  synced: false,
  hasEverSynced: false,
  status: 'connecting',
  writeAccess: 'unknown',
  authFailedReason: null,
};

/** The connection of the Space tab a component renders inside. */
export const SpaceConnectionContext = React.createContext<SocketState>(NOT_CONNECTED);

/**
 * The connection of the Space tab this component renders inside.
 * @returns The connection; "connecting" outside an open tab with a document.
 */
export function useSpaceConnection(): SocketState {
  return React.useContext(SpaceConnectionContext);
}

/**
 * Doc-name builder per Space type. A type absent from this table has no Yjs
 * document yet, and attaching is skipped for it — adding one later is a single
 * entry here rather than another branch in the component.
 *
 * The doc NAME carries the Space kind, so a canvas and a document Space that
 * happen to share an id still resolve to two separate documents.
 */
export const DOC_NAME_BUILDERS: Partial<
  Record<SpaceType, (projectId: string, spaceId: string) => string>
> = {
  canvas: docName.canvasSpace,
  document: docName.documentSpace,
};
