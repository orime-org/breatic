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

  it("drops a fragment, and says it was a fragment", () => {
    // It used to come out as `?<redacted>` — a query string that was never
    // sent. The fragment is still dropped; it is just no longer mislabelled.
    expect(redactUrl("https://vendor.test/v1/go#token=abc")).toBe(
      "https://vendor.test/v1/go#<redacted>",
    );
  });

  it("marks a query and a fragment separately when both are present", () => {
    expect(redactUrl("https://vendor.test/v1/go?key=SECRET#token=abc")).toBe(
      "https://vendor.test/v1/go?<redacted>#<redacted>",
    );
  });

  it("refuses to echo back a string it could not parse", () => {
    // Echoing an unparseable value would mean guessing which part was secret.
    expect(redactUrl("key=AIzaSecret&not-a-url")).toBe("<unparseable url>");
  });

  it("refuses to echo back a scheme whose payload does not live in the query", () => {
    // `origin + pathname` is an http-shaped assumption. A `data:` URL parses
    // fine and carries its whole payload in the path, so the redaction that
    // works for `?key=` hands the payload straight back — measured before the
    // fix: `data:text/plain,SECRET` came out as `nulltext/plain,SECRET`.
    //
    // Reachable, and not hypothetically: the agent's fetch tool takes a URL
    // from the model, the SSRF guard rejects the non-http scheme, and the
    // transport then redacts that same URL for its exhausted event on the way
    // out. The guard stops the REQUEST; it does not stop the string reaching a
    // log. Only the scheme is safe to name, so only the scheme is named.
    expect(redactUrl("data:text/plain,MY-SECRET-TOKEN")).toBe("<non-http url: data:>");
    expect(redactUrl("file:///etc/passwd")).toBe("<non-http url: file:>");
    expect(redactUrl("blob:https://x.test/abc")).toBe("<non-http url: blob:>");
    expect(redactUrl("mailto:a@b.test?subject=SECRET")).toBe("<non-http url: mailto:>");
  });
});

