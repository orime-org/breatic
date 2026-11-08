// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the server asks the ingest Worker's page reader, and what comes back
 * (inner#1664). Both sides parse with these schemas.
 */
import { z } from "zod";

import type { ContainerUsage } from "@shared/upload/mini-tool-job.js";

/** How reading one page ended. */
export const READ_PAGE_STATUSES = [
  "ok",
  "unreachable",
  "needs_login",
  "refused",
  "busy",
  "too_slow",
  "unsupported_type",
  "too_large",
  "empty",
] as const;

/** How reading one page ended. */
export type ReadPageStatus = (typeof READ_PAGE_STATUSES)[number];

/** One call's pages and the limits the reader works within. */
export interface ReadPagesRequest {
  urls: string[];
  deadlineAt: number;
  pageTimeoutMs: number;
  settleMs: number;
  concurrency: number;
  maxBytes: number;
}

/** What reading one page produced. */
export interface ReadPageResult {
  url: string;
  status: ReadPageStatus;
  httpStatus?: number;
  finalUrl?: string;
  title?: string;
  kind?: "html" | "pdf";
  pages?: number;
  text?: string;
}

/** What one call produced, with what the container used. */
export interface ReadPagesAnswer {
  pages: ReadPageResult[];
  usage: ContainerUsage;
}

/** The request as the Worker reads it. Placeholder until implemented. */
export const readPagesRequestSchema: z.ZodType<ReadPagesRequest> = z.never();

/** One page's result as the server reads it. Placeholder until implemented. */
export const readPageResultSchema: z.ZodType<ReadPageResult> = z.never();

/** The answer as the server reads it. Placeholder until implemented. */
export const readPagesAnswerSchema: z.ZodType<ReadPagesAnswer> = z.never();
