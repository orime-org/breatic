// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { getDoc } from '@web/data/yjs/manager';
import { getSceneSession } from '@web/data/yjs/scene-session';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { useCollabSocketContext } from '@web/data/yjs/collab-socket';

/**
 * Keep permission and presence facts alive with the tab, outside its hidden body.
 * @param root0 - Scene identity and editing properties from the Space host.
 * @param root0.name - Canonical scene content-document name.
 * @param root0.readOnly - Whether the Project role restricts this user to viewing.
 * @returns No visual content; its effects follow the open tab.
 */
export function SceneConnectionLifetime({ name, readOnly = true }: {
  name: string; readOnly?: boolean;
}): null {
  const { userId } = useCollabSocketContext();
  const connection = useSpaceConnection();
  React.useEffect(() => {
    if (!userId) return;
    const session = getSceneSession(getDoc(name), name);
    session.setEnvironment({ readOnly, connected: connection.status === 'connected',
      hasEverSynced: connection.hasEverSynced, writeAccess: connection.writeAccess,
      refused: connection.status === 'authFailed', awareness: connection.provider?.awareness ?? null });
  }, [userId, name, readOnly, connection.status, connection.provider, connection.hasEverSynced, connection.writeAccess]);
  return null;
}
