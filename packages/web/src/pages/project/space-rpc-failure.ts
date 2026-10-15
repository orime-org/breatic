// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { SpaceRpcErrorCode, SpaceRpcRequest } from '@breatic/shared';

/** How a refused Space RPC is shown: the toast level, and the line under its title. */
export interface SpaceRpcFailureNotice {
  /** `warning` when the reader hit a limit, `error` when the operation failed. */
  level: 'error' | 'warning';
  /** Locale key of the description; absent when the title says enough. */
  descriptionKey?: string;
}

/**
 * Say what a refused Space RPC means to the reader. The server's own message
 * is a developer string in English and never reaches the screen; each code the
 * reader can act on gets its own line, the rest show only the title.
 * @param type - The RPC that was refused.
 * @param code - The code the server answered with.
 * @returns The toast level and, when there is one, the description key.
 */
export function spaceRpcFailureNotice(
  type: SpaceRpcRequest['type'],
  code: SpaceRpcErrorCode,
): SpaceRpcFailureNotice {
  if (code === 'SPACE_LIMIT') {
    return { level: 'warning', descriptionKey: 'project.space.error.limit' };
  }
  if (code === 'BUSY') {
    return { level: 'error', descriptionKey: 'project.space.error.busy' };
  }
  if (code === 'CONFLICT' && type === 'space:delete') {
    return { level: 'error', descriptionKey: 'spaces.drawer.action.deleteLastSpace' };
  }
  if (code === 'CONFLICT' && type === 'space:restore') {
    return { level: 'error', descriptionKey: 'project.space.error.alreadyRestored' };
  }
  if (code === 'NOT_FOUND' && type !== 'space:restore' && type !== 'space:create') {
    return { level: 'error', descriptionKey: 'project.space.error.gone' };
  }
  return { level: 'error' };
}
