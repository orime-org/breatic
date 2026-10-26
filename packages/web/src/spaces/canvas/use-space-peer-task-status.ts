// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { usePeerActivity } from '@web/spaces/canvas/use-peer-activity';

/**
 * Read existing peer activity for nodes still shown in this document.
 * @param awareness - Existing provider awareness.
 * @param contentNodeIds - Current content node ids.
 * @returns Whether a peer has ongoing activity on a current node.
 * @throws {never} Never.
 */
export function useSpacePeerTaskStatus(awareness: Awareness | null, contentNodeIds: ReadonlySet<string>): boolean {
  const peers = usePeerActivity(awareness);
  return React.useMemo(() => [...peers.keys()].some((id) => contentNodeIds.has(id)), [peers, contentNodeIds]);
}
