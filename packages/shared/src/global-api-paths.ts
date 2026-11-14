// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The API paths, under `/api/v1`, whose data lives only in the global region
 * (inner#1955). The web sends them to the global region, and a server in any
 * other region refuses them at the door.
 */
export const GLOBAL_API_PATHS = /^\/(auth|users|studios|credits|payment|account|directory)(\/|\?|$)/;
