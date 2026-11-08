// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Reading one call's pages a few at a time, within its deadline (inner#1664). */
import type { ReadPageResult } from "@breatic/shared";

/** How `readAll` reads. */
export interface ReadAllOptions {
  /** The most pages read at once. */
  concurrency: number;
  /** When the call's answer is due, epoch ms; reading stops 5 s before it. */
  deadlineAt: number;
  /** Read one page; the signal fires when the page must stop. */
  readOne: (url: string, signal: AbortSignal) => Promise<ReadPageResult>;
}

/**
 * Read every page, at most `concurrency` at once.
 * @param urls - The pages, in the caller's order.
 * @param options - Concurrency, deadline and the reader of one page.
 * @returns One result per url, in the order of `urls`.
 * @throws {Error} Always, until implemented.
 */
export async function readAll(urls: string[], options: ReadAllOptions): Promise<ReadPageResult[]> {
  void urls;
  void options;
  throw new Error("not implemented: readAll");
}
