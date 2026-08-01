// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `web_fetch` is the one caller on the shared transport that does not choose
 * its own URL — the model names the host — so every bound it places on the
 * answer is a real boundary rather than housekeeping.
 *
 * It had no tests at all — measured by mutation, its byte ceiling could be
 * removed with the whole suite still green. These cover what the shared
 * transport does for this tool; the readable-text extraction and the SSRF
 * refusal message are each their own change with their own tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { getAgentConfig } from "@breatic/core";

import { webFetch } from "@domain/agent/tools/web-fetch.js";

/** What the tool hands back, once parsed. */
interface ToolResult {
  error?: string;
  url?: string;
  text?: string;
  length?: number;
  truncated?: boolean;
}

/**
 * Drive the tool the way the agent runtime does.
 * @param args - The tool arguments.
 * @returns The parsed result envelope.
 */
async function run(args: { url: string; maxChars?: number }): Promise<ToolResult> {
  // The `ai` package types `execute` as optional and passes a call context we
  // do not use; the cast keeps the test to the shape the runtime actually
  // invokes.
  const execute = webFetch.execute as (a: typeof args) => Promise<string>;
  return JSON.parse(await execute(args)) as ToolResult;
}

/**
 * Serve one body for every request.
 * @param body - The body text.
 * @param headers - Response headers.
 */
function serve(body: string, headers: Record<string, string> = {}): void {
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response(body, { status: 200, headers }))) as unknown as typeof fetch;
}

// The character limit, the readable-text extraction and the SSRF refusal
// message are exercised by their own PRs; this file covers only what the
// shared transport does for this tool.

describe("web_fetch — bounds on an answer we do not control", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a body past the byte ceiling before it is buffered", async () => {
    // The character limit runs on a string that is already in memory, so it is
    // no defence at all against a host that answers with a gigabyte. Removing
    // this wiring left every test green.
    serve("z".repeat(getAgentConfig().web_fetch_max_bytes + 1_000));

    const result = await run({ url: "https://example.test/" });

    expect(result.error).toMatch(/exceeded \d+ bytes/);
  });

  it("answers a chat turn against the interactive ceiling, not the background one", async () => {
    // Someone is watching a chat turn wait on this. Thirty seconds sits above
    // the ten-second ceiling for a person and below the sixty-second one for
    // background work, so it separates the two: declared interactive, the tool
    // gives up at once; without that declaration it sleeps out the thirty
    // seconds and tries again.
    //
    // The race is what makes the failure an assertion rather than a timeout —
    // an undeclared tool leaves this pending, and `pending` is what gets
    // asserted on.
    let attempts = 0;
    globalThis.fetch = ((): Promise<Response> => {
      attempts += 1;
      return Promise.resolve(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      );
    }) as unknown as typeof fetch;

    const outcome = await Promise.race([
      run({ url: "https://example.test/" }).then(() => "refused" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 2_000)),
    ]);

    expect(outcome).toBe("refused");
    expect(attempts).toBe(1);
  });

  it("lets go of the connection when the page answers with an error", async () => {
    // Returning without touching the body leaves it unread, and an unread body
    // holds its connection until the peer gives up. The guarded handle has no
    // "throw this away" member by design, so draining is how a caller lets go.
    // `bodyUsed` is the observable: false means nothing ever touched it.
    let served: Response | undefined;
    globalThis.fetch = ((): Promise<Response> => {
      served = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html>gone</html>"));
            controller.close();
          },
        }),
        { status: 404 },
      );
      return Promise.resolve(served);
    }) as unknown as typeof fetch;

    const result = await run({ url: "https://example.test/missing" });

    expect(result.error).toBe("HTTP 404");
    expect(served?.bodyUsed).toBe(true);
  });
});
