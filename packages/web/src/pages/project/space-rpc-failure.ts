// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { SpaceRpcErrorCode, SpaceRpcRequest } from '@breatic/shared';

/**
 * How a refused Space RPC is shown. A guard that stopped the reader (a limit,
 * a busy lock) is a one-line warning stating the reason; a failed operation is
 * an error titled with the action, with an optional line under it.
 */
export type SpaceRpcFailureNotice =
  | { level: 'warning'; messageKey: string }
  | { level: 'error'; descriptionKey?: string };

/**
 * Say what a refused Space RPC means to the reader. The server's own message
 * is a developer string in English and never reaches the screen; each code the
 * reader can act on gets its own line, the rest show only the title.
 * @param type - The RPC that was refused.
 * @param code - The code the server answered with.
 * @returns The warning's message key, or the error's description key when there is one.
 */
export function spaceRpcFailureNotice(
  type: SpaceRpcRequest['type'],
  code: SpaceRpcErrorCode,
): SpaceRpcFailureNotice {
  if (code === 'SPACE_LIMIT') {
    return { level: 'warning', messageKey: 'project.space.error.limit' };
  }
  if (code === 'BUSY') {
    return { level: 'warning', messageKey: 'project.space.error.busy' };
  }
  if (code === 'CONFLICT' && type === 'space:delete') {
    return { level: 'error', descriptionKey: 'spaces.drawer.action.deleteLastSpace' };
  }
  // A restore is offered only for a deletion that was recorded, so NOT_FOUND
  // here means that record was already consumed by a restore, and CONFLICT
  // that the Space is listed again.
  if (type === 'space:restore' && (code === 'NOT_FOUND' || code === 'CONFLICT')) {
    return { level: 'error', descriptionKey: 'project.space.error.alreadyRestored' };
  }
  if (code === 'NOT_FOUND') {
    return { level: 'error', descriptionKey: 'project.space.error.gone' };
  }
  return { level: 'error' };
}
