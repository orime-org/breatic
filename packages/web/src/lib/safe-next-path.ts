// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Resolve an auth-flow destination to an absolute path within the app.
 * @param next - The destination carried by the current auth route.
 * @returns The supplied app path, or the Studio home.
 */
export function safeNextPath(next: string | null): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/studio';
}
