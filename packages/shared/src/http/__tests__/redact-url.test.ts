// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A retry event must never carry a credential.
 *
 * Google's image and video endpoints authenticate through the query string,
 * so the first cut of the retry telemetry put a live API key into the
 * worker's structured logs every time one of them returned a 503.
 *
 * Two cases that used to live here are gone, and neither property went with
 * them. `redactUrl` no longer parses, so "a string it could not parse" and "a
 * scheme whose payload lives in the path" are no longer inputs it can be
 * given — the boundary refuses both before anything reaches redaction. Those
 * two properties are asserted where they now hold, in real-fetch.test.ts:
 * "refuses %s at the boundary", which checks the refusal quotes none of the
 * string it refused.
 */

import { describe, it, expect } from "vitest";

import { redactUrl } from "@shared/http/redact-url.js";

describe("redactUrl", () => {
  it("drops a query string carrying an API key", () => {
    const out = redactUrl(
      new URL(
        "https://generativelanguage.googleapis.com/v1beta/models/imagen:generateContent?key=AIzaSyREAL_LOOKING_SECRET",
      ),
    );

    expect(out).not.toContain("AIzaSyREAL_LOOKING_SECRET");
    expect(out).not.toContain("key=");
    // The endpoint must stay identifiable — that is the whole point of the log.
    expect(out).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/imagen:generateContent?<redacted>",
    );
  });

  it("leaves a clean URL untouched so logs stay readable", () => {
    expect(redactUrl(new URL("https://api.wavespeed.ai/v3/predictions"))).toBe(
      "https://api.wavespeed.ai/v3/predictions",
    );
  });

  it("drops a fragment, and says it was a fragment", () => {
    // It used to come out as `?<redacted>` — a query string that was never
    // sent. The fragment is still dropped; it is just no longer mislabelled.
    expect(redactUrl(new URL("https://vendor.test/v1/go#token=abc"))).toBe(
      "https://vendor.test/v1/go#<redacted>",
    );
  });

  it("marks a query and a fragment separately when both are present", () => {
    expect(redactUrl(new URL("https://vendor.test/v1/go?key=SECRET#token=abc"))).toBe(
      "https://vendor.test/v1/go?<redacted>#<redacted>",
    );
  });
});
