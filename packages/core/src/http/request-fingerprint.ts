// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The fingerprint an idempotent internal write keeps beside its key: one
 * text over the method, the route template, the target id and the body, so a
 * key reused for a different request is told apart from a retry.
 */

import { createHash } from "node:crypto";

/**
 * JSON with every object's keys sorted, so field order does not make two
 * bodies different requests.
 * @param value - Parsed JSON.
 * @returns The canonical text.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The request's fingerprint, kept in `request_hash`.
 * @param method - HTTP method.
 * @param routeTemplate - The route's path template.
 * @param targetId - The `lotId` or `operationId` in the path.
 * @param body - The parsed body.
 * @returns Lowercase hex SHA-256.
 */
export function fingerprint(
  method: string,
  routeTemplate: string,
  targetId: string,
  body: unknown,
): string {
  return createHash("sha256")
    .update([method, routeTemplate, targetId, canonicalJson(body)].join("\n"))
    .digest("hex");
}
