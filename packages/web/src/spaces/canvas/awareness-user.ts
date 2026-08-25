// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Read one awareness entry's user id, if the server has stamped one.
 *
 * Every accepted connection has its `user.id` written by the server, so an
 * entry without one is either mid-handshake or something we have no name for
 * either way. The value is checked rather than trusted: awareness carries
 * whatever a peer put there, and this feeds a render.
 * @param state - One client's awareness state.
 * @returns The user id, or null when there is none to render.
 */
export function readUserId(state: Record<string, unknown>): string | null {
  const user = state.user;
  const id = typeof user === 'object' && user !== null ? (user as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : null;
}
