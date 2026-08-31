// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the Worker says when it was deployed without its configuration.
 *
 * Each value here comes from a file somebody fills in by hand — `wrangler.toml`
 * from its template, `.dev.vars` from its own, `wrangler secret put` for the
 * deployed one. A missing one is therefore ordinary, and the answer has to name
 * which one so the person filling the file knows what to add.
 */

import { createExecutionContext, waitOnExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "@ingest/index.js";

/** Send one request with `env` missing the named settings. */
async function askWithout(...missing: string[]): Promise<Response> {
  const partial: Record<string, unknown> = { ...env };
  for (const key of missing) delete partial[key];
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://ingest.example.com/uploads", { method: "POST" }),
    partial as unknown as typeof env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("a Worker whose configuration is incomplete", () => {
  it("names the one setting that is missing", async () => {
    const response = await askWithout("SERVER_REPORT_URL");

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("SERVER_REPORT_URL");
  });

  it("names every missing setting, not just the first", async () => {
    const response = await askWithout("SERVER_REPORT_URL", "ALLOWED_ORIGINS");

    const said = await response.text();
    expect(said).toContain("SERVER_REPORT_URL");
    expect(said).toContain("ALLOWED_ORIGINS");
  });

  it("counts an empty string as missing", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://ingest.example.com/uploads", { method: "POST" }),
      { ...env, INGEST_SHARED_SECRET: "" },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("INGEST_SHARED_SECRET");
  });

  // The sentence is no use to a browser that cannot read the response, and a
  // cross-origin caller cannot read one without these headers — it reports a
  // CORS failure instead, which says nothing about what is wrong here.
  it("sends the answer through the headers that let it be read", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://ingest.example.com/uploads", {
        method: "POST",
        headers: { origin: "https://app.test.example" },
      }),
      { ...env, SERVER_REPORT_URL: "" },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.test.example",
    );
  });

  // The preflight is answered before the configuration is judged, for the same
  // reason: a refused one is a CORS error, and the browser never sends the
  // request that would have carried the sentence naming what to fix.
  it("still lets the preflight through so that answer can arrive", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://ingest.example.com/uploads", {
        method: "OPTIONS",
        headers: { origin: "https://app.test.example" },
      }),
      { ...env, SERVER_REPORT_URL: "" },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
  });

  // Nothing is allowed when the list itself is what is missing, so this one
  // stays unreadable to a browser — the operator reads it from a log or a
  // request that carries no origin at all.
  it("names a missing origin list on a request that can still read it", async () => {
    const partial: Record<string, unknown> = { ...env };
    delete partial["ALLOWED_ORIGINS"];
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://ingest.example.com/uploads", { method: "POST" }),
      partial as unknown as typeof env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("ALLOWED_ORIGINS");
  });
});
