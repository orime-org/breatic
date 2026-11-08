// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page reader (inner#1664): one instance per `web_fetch` call, a headless
 * browser inside, every request it makes answered by `webReaderOutbound`.
 */
import { Container } from "@cloudflare/containers";
import type { ReadPagesAnswer, ReadPagesRequest } from "@breatic/shared";

/** One call's page reader. */
export class WebReaderContainer extends Container {
  /** No route out but the outbound handler. */
  enableInternet = false;

  /** Carries that to HTTPS as well. */
  interceptHttps = true;

  /**
   * Read the pages, then destroy the instance.
   * @param request - The pages and the limits to read them within.
   * @returns What each page produced, and what the container used.
   * @throws {Error} Always, until implemented.
   */
  async read(request: ReadPagesRequest): Promise<ReadPagesAnswer> {
    void request;
    throw new Error("not implemented: WebReaderContainer.read");
  }
}
