// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project route-param helpers for the `/project/{slug}-{uuid}` URL
 * (URL design §5.7).
 *
 * The route param is a human-readable `{slug}-{uuid}` composite, but the
 * canonical project identifier — used for the REST API, the Yjs document name,
 * and every downstream lookup — is the bare UUID. The slug is decorative
 * (readable URLs); the uuid is what the backend keys on. Consumers of the
 * `:projectId` route param MUST extract the uuid before using it: the backend
 * `project_members.project_id` column is a UUID, so passing the whole
 * composite throws `invalid input syntax for type uuid`.
 */

/**
 * A canonical lowercase UUID (8-4-4-4-12 hex), anchored at the END of the
 * string so the trailing uuid of a `{slug}-{uuid}` composite is matched even
 * when the slug itself contains hyphens.
 */
const TRAILING_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the bare project UUID from a `/project/{slug}-{uuid}` route param.
 *
 * Returns the trailing uuid for a `{slug}-{uuid}` composite, a bare uuid
 * unchanged, and any non-uuid input (e.g. the `'demo'` fallback) untouched so
 * callers can keep their own "no real id yet" guards.
 * @param param - The raw `:projectId` route param from `useParams`.
 * @returns The canonical project uuid, or the input unchanged when it carries
 *   no trailing uuid.
 */
export function projectUuidFromRouteParam(param: string): string {
  const match = param.match(TRAILING_UUID);
  return match ? match[0] : param;
}
