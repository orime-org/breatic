// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web fetch tool — reads the pages behind links the conversation holds
 * (inner#1664). Built by `makeWebTools`, which shares one run of citation
 * numbers with `web_search`.
 */
import type { ReadPageStatus, ReadPagesAnswer, ReadPagesRequest } from "@breatic/shared";

/** How the server reads pages for one call: rate limited, then sent to the ingest Worker. */
export type ReadPages = (request: ReadPagesRequest, signal?: AbortSignal) => Promise<ReadPagesAnswer>;

/** The server would not read pages for this call. */
export class ReadPagesRefused extends Error {
  /**
   * @param reason - Why the read was refused.
   */
  constructor(readonly reason: "rate_limited") {
    super(`pages not read: ${reason}`);
    this.name = "ReadPagesRefused";
  }
}

/** How one page of a call ended, including a link the conversation does not hold. */
export type FetchStatus = ReadPageStatus | "not_in_conversation";

/** One page of a call, as the model and the panel read it. */
export interface FetchedPage {
  url: string;
  status: FetchStatus;
  final_url?: string;
  title?: string;
  kind?: "html" | "pdf";
  pages?: number;
  chars_total?: number;
  start?: number;
  end?: number;
  next_start?: number | null;
  text?: string;
  links: string[];
  index?: number;
}

/** One page read, as the source row draws it. */
export interface FetchSource {
  url: string;
  title: string;
  publisher: string;
  index: number;
}

/** What one call answers with. */
export interface FetchAnswer {
  pages: FetchedPage[];
  sources: FetchSource[];
}

/**
 * Render a call's pages for the model to read.
 * @param answer - What the call read.
 * @returns The text handed to the model.
 * @throws {Error} Always, until implemented.
 */
export function renderFetchForModel(answer: FetchAnswer): string {
  void answer;
  throw new Error("not implemented: renderFetchForModel");
}
