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

  // The check runs before anything reads a binding, so a request that would
  // have thrown deeper in still gets the answer that says what to fix.
  it("says so before the preflight branch as well", async () => {
    const partial: Record<string, unknown> = { ...env };
    delete partial["ALLOWED_ORIGINS"];
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://ingest.example.com/uploads", {
        method: "OPTIONS",
        headers: { origin: "https://app.test.example" },
      }),
      partial as unknown as typeof env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("ALLOWED_ORIGINS");
  });
});
