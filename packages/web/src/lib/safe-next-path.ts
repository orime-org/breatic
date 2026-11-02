// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolve an auth-flow destination to an absolute path within the app.
 * @param next - The destination carried by the current auth route.
 * @returns The supplied app path, or the Studio home.
 */
export function safeNextPath(next: string | null): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/studio';
}
