// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Matches a UUID the way Postgres renders a `uuid` column: 8-4-4-4-12 hex,
 * any version and variant. The id columns accept any such value, so a reader
 * of their text form checks this shape rather than an RFC version.
 */
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
