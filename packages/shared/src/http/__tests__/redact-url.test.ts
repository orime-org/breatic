// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A retry event must never carry a credential.
 *
 * Google's image and video endpoints authenticate through the query string,
 * so the first cut of the retry telemetry put a live API key into the
 * worker's structured logs every time one of them returned a 503.
 */

import { describe, it, expect } from "vitest";

import { redactUrl } from "@shared/http/redact-url.js";
import { httpRequest } from "@shared/http/request.js";
import type { HttpRetryEvent } from "@shared/http/request.js";

describe("redactUrl", () => {
  it("drops a query string carrying an API key", () => {
    const out = redactUrl(
      "https://generativelanguage.googleapis.com/v1beta/models/imagen:generateContent?key=AIzaSyREAL_LOOKING_SECRET",
    );

    expect(out).not.toContain("AIzaSyREAL_LOOKING_SECRET");
    expect(out).not.toContain("key=");
    // The endpoint must stay identifiable — that is the whole point of the log.
    expect(out).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/imagen:generateContent?<redacted>",
    );
  });

  it("leaves a clean URL untouched so logs stay readable", () => {
    expect(redactUrl("https://api.wavespeed.ai/v3/predictions")).toBe(
      "https://api.wavespeed.ai/v3/predictions",
    );
  });

  it("drops a fragment too", () => {
    expect(redactUrl("https://vendor.test/v1/go#token=abc")).toBe(
      "https://vendor.test/v1/go?<redacted>",
    );
  });

  it("refuses to echo back a string it could not parse", () => {
    // Echoing an unparseable value would mean guessing which part was secret.
    expect(redactUrl("key=AIzaSecret&not-a-url")).toBe("<unparseable url>");
  });
});

describe("retry telemetry", () => {
  it("reports a redacted URL, so a key in the query never reaches a log", async () => {
    const secretUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/imagen:generateContent?key=AIzaSyREAL_LOOKING_SECRET";
    const events: HttpRetryEvent[] = [];
    let call = 0;
    const fetchImpl = ((): Promise<Response> => {
      call += 1;
      return Promise.resolve(new Response("{}", { status: 503 }));
    }) as unknown as typeof fetch;

    await httpRequest(
      secretUrl,
      {},
      {
        replaySafe: true,
        timeoutMs: 1_000,
        bodyIdleTimeoutMs: 200,
        fetchImpl,
        onEvent: (e) => events.push(e),
        label: "google",
      },
    );

    expect(call).toBeGreaterThan(1); // it really did retry
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.url).not.toContain("AIzaSyREAL_LOOKING_SECRET");
      expect(event.url).not.toContain("key=");
    }
  });
});
