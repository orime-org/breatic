// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";

/**
 * Root Y.Map of the project meta document that records whom each connection
 * follows (#920), keyed by socket id. Collab writes it and web reads it.
 *
 * It is kept by the server per connection rather than read off browser
 * awareness, because awareness ages a hidden tab out on the browser's
 * throttled timers while the connection itself is still alive.
 */
export const FOLLOWING_TABLE = "following";

/**
 * One connection's entry: who owns it, whom they follow, when they started
 * (the browser's clock, so two tabs of one user order by it) and when the
 * socket was last heard (the server's clock, for the stale sweep).
 */
export const followingEntrySchema = z.object({
  userId: z.string().min(1),
  target: z.string().min(1),
  at: z.number(),
  lastSeenAt: z.number(),
});

/** One entry of {@link FOLLOWING_TABLE}. */
export type FollowingEntry = z.infer<typeof followingEntrySchema>;

/**
 * What a browser tab declares in meta awareness as `following`: whom it
 * follows and when it started following that member. Collab records it into
 * {@link FOLLOWING_TABLE}; anything that fails this schema reads as "follows
 * nobody".
 */
export const followingDeclarationSchema = z.object({
  id: z.string().min(1),
  at: z.number().finite(),
});

/** A tab's `following` declaration. */
export type FollowingDeclaration = z.infer<typeof followingDeclarationSchema>;
