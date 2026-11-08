// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How one turn's `web_fetch` reads pages: rate limited per user, then sent to
 * the ingest Worker (inner#1664).
 */
import type { ReadPages } from "@breatic/domain";

/**
 * The read one turn hands its tool, bound to the user.
 * @param who - The turn's user.
 * @param who.userId - Who the calls are counted against.
 * @returns The read.
 * @throws {Error} Always, until implemented.
 */
export function readPagesFor(who: { userId: string }): ReadPages {
  void who;
  throw new Error("not implemented: readPagesFor");
}
