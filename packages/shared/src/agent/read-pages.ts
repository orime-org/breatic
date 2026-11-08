// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the server asks the ingest Worker's page reader, and what comes back
 * (inner#1664). Both sides parse with these schemas.
 */
import { z } from "zod";

import { containerUsageSchema, type ContainerUsage } from "@shared/upload/container-usage.js";

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

/** The longest link `web_fetch` takes; a contract bound, shared by both ends. */
export const READ_PAGE_MAX_URL_CHARS = 2048;

/**
 * Whether a string is an http or https address.
 * @param value - The string.
 * @returns True for an http or https URL.
 */
function isWebAddress(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const webAddress = z.string().max(READ_PAGE_MAX_URL_CHARS).refine(isWebAddress, "an http or https address");

/** The request as the Worker reads it. */
export const readPagesRequestSchema: z.ZodType<ReadPagesRequest> = z.object({
  urls: z.array(webAddress).min(1),
  deadlineAt: z.number().int().positive(),
  pageTimeoutMs: z.number().int().positive(),
  settleMs: z.number().int().nonnegative(),
  concurrency: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
});

/** One page's result as the server reads it. */
export const readPageResultSchema: z.ZodType<ReadPageResult> = z.object({
  url: z.string(),
  status: z.enum(READ_PAGE_STATUSES),
  httpStatus: z.number().int().optional(),
  finalUrl: z.string().optional(),
  title: z.string().optional(),
  kind: z.enum(["html", "pdf"]).optional(),
  pages: z.number().int().nonnegative().optional(),
  text: z.string().optional(),
});

/** The answer as the server reads it. */
export const readPagesAnswerSchema: z.ZodType<ReadPagesAnswer> = z.object({
  pages: z.array(readPageResultSchema),
  usage: containerUsageSchema,
});
