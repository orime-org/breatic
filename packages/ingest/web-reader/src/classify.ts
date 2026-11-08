// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a page's first response already says about how reading it ends
 * (inner#1664).
 */
import type { ReadPageStatus } from "@breatic/shared";

/** Types whose body is text a page can be read from, besides `text/*`. */
const READABLE = new Set(["application/pdf", "application/xhtml+xml", "application/xml", "application/json"]);

/**
 * How reading a page ends, judged from its response's status and type.
 * @param httpStatus - The response's HTTP status.
 * @param contentType - Its `content-type` header, or null when it sent none.
 * @returns The page's status, or null when the page should be read on.
 * @throws {never} Never.
 */
export function statusOfResponse(httpStatus: number, contentType: string | null): ReadPageStatus | null {
  if (httpStatus === 401 || httpStatus === 407) return "needs_login";
  if (httpStatus === 403) return "refused";
  if (httpStatus === 429 || httpStatus >= 500) return "busy";
  if (httpStatus >= 400) return "unreachable";
  if (contentType === null) return null;
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return type === "" || type.startsWith("text/") || READABLE.has(type) ? null : "unsupported_type";
}
