// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The API paths, under `/api/v1`, whose data lives only in the global region
 * (inner#1955). The web sends them to the global region, and a server in any
 * other region refuses them at the door. The user lookup by id (`/users?ids=`)
 * is not one of them: every region answers it from the global directory
 * through its profile cache; only what lies under `/users/` is global.
 */
export const GLOBAL_API_PATHS = /^\/(?:(?:auth|studios|credits|payment|account|directory)(?:\/|\?|$)|users\/)/;
