// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Comparing a presented secret with the one we hold.
 *
 * Both endpoints our own Cloudflare Worker calls use this: the permission to
 * finish a key, and the report an upload's outcome arrives on. Neither carries
 * a session, so this comparison is the whole of what identifies the caller.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Compare two secrets without leaking where they diverge.
 * @param a - The value the caller sent.
 * @param b - The value we hold.
 * @returns True when they are the same string.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // signal, so the lengths are compared first and the result folded in.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
