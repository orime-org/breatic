// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the Worker answers to a path it does not serve.
 *
 * This Worker is on the public internet with no session behind it, so the
 * shape of its refusals is part of the contract: an unknown path says nothing
 * about what the known ones are.
 */

import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "@ingest/index.js";

describe("an unknown path", () => {
  it("is refused", async () => {
    const request = new Request("https://ingest.example.com/nothing-here");
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(404);
  });

  it("is refused for a stored object's key too", async () => {
    const key = "image/2026-08-13/stored.png";
    await env.BUCKET.put(key, new Uint8Array([1, 2, 3]));
    const ctx = createExecutionContext();

    for (const method of ["GET", "HEAD"]) {
      const request = new Request(`https://ingest.example.com/download/${key}`, { method });
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(404);
    }
  });
});
