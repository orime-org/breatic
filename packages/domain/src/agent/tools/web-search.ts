// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Web search tool — Brave Search API.
 *
 * Ported from backend/agent/tools/builtin/web.py (WebSearchTool).
 */
import { tool } from "ai";
import { z } from "zod";
import { env } from "@breatic/core";

/**
 * Search the web using the Brave Search API.
 *
 * Returns formatted results containing titles, URLs, and descriptions.
 * Requires the `BRAVE_SEARCH_API_KEY` environment variable.
 */
export const webSearch = tool({
  description: "Search the web. Returns titles, URLs, and snippets.",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    count: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Number of results (1-10)"),
  }),
  execute: async ({ query, count }): Promise<string> => {
    // BRAVE_SEARCH_API_KEY is a typed config field (defaults to "");
    // read via the injected config Proxy, not process.env directly.
    const apiKey = env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return "Error: Brave Search API key not configured. Set BRAVE_SEARCH_API_KEY in your .env file.";
    }

    const n = Math.min(Math.max(count ?? 5, 1), 10);

    try {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(n));

      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        return `Error: Brave Search returned HTTP ${res.status}`;
      }

      const data = (await res.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      const results = (data.web?.results ?? []).slice(0, n);
      if (results.length === 0) return `No results found for: ${query}`;

      const lines = [`Results for: ${query}\n`];
      results.forEach((item, i) => {
        lines.push(`${i + 1}. ${item.title ?? ""}\n   ${item.url ?? ""}`);
        if (item.description) lines.push(`   ${item.description}`);
      });
      return lines.join("\n");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  },
});
