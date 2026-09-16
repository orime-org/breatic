// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many ids `GET /users` answers for in one call.
 *
 * The endpoint takes the first this many and drops the rest without saying so,
 * which is fine for an endpoint but not for a caller that cannot see the
 * number: a board naming more people than this had everybody past the cap come
 * back nameless with nothing to report it. Shared so the route that enforces
 * it and the client that batches against it read the same one.
 */
export const USER_LOOKUP_MAX_IDS = 100;
