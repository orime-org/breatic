// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The tools one turn reads the web with: `web_search` and `web_fetch`, sharing
 * one run of citation numbers (inner#1664).
 */
import type { Tool } from "ai";

import type { ToolContext } from "@domain/agent/tools/index.js";

/**
 * This turn's web tools.
 * @param context - What the turn knows that the tools need when built.
 * @returns The two tools, keyed as the model names them.
 * @throws {Error} Always, until implemented.
 */
export function makeWebTools(context?: ToolContext): { web_search: Tool; web_fetch: Tool } {
  void context;
  throw new Error("not implemented: makeWebTools");
}

/**
 * Name the publisher a page belongs to.
 * @param url - The page's address.
 * @returns The publisher's name.
 * @throws {Error} Always, until implemented.
 */
export function publisherOf(url: string): string {
  void url;
  throw new Error("not implemented: publisherOf");
}
