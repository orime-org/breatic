// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a page's first response already says about how reading it ends
 * (inner#1664).
 */
import type { ReadPageStatus } from "@breatic/shared";

/**
 * How reading a page ends, judged from its response's status and type.
 * @param httpStatus - The response's HTTP status.
 * @param contentType - Its `content-type` header, or null when it sent none.
 * @returns The page's status, or null when the page should be read on.
 * @throws {Error} Always, until implemented.
 */
export function statusOfResponse(httpStatus: number, contentType: string | null): ReadPageStatus | null {
  void httpStatus;
  void contentType;
  throw new Error("not implemented: statusOfResponse");
}
