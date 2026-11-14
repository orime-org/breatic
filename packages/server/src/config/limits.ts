// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The business limits of `config/limits.yaml`, loaded once in core
 * (`@core/config/limits.ts`). Server modules import them from here so tests
 * that mock this module keep replacing what the routes read.
 */

export {
  limitsConfigSchema,
  getActivityFeedPageLimits,
  getStudioProjectPageLimits,
  getCreditPageLimits,
  getCanvasReferencePoolCap,
  getNodeHistoryPageSize,
  getDocumentVersionLimits,
  MS_PER_DAY,
  getDecisionWindowDays,
  getDecisionWindowMs,
  getDecisionWindowSeconds,
  getStorageNoticeWindowSeconds,
  getRequestBodyMaxBytes,
  getRequestBodyLingerSeconds,
} from "@breatic/core";
