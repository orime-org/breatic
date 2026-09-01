// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two settings an S3-compatible bucket is reached through (#173).
 *
 * R2 speaks the S3 API, so one implementation serves both; what differs is
 * where the requests go and how a stored object is read back. Those two are
 * separate addresses and confusing them is the failure this pins:
 *
 *   - the API endpoint answers only to SigV4-signed requests. On R2 it is
 *     account-scoped rather than regional, which is why the client needs an
 *     explicit `endpoint` at all — without one the SDK builds an AWS hostname
 *     and every write goes to a bucket we do not own.
 *   - the public base is what a browser fetches. A URL built on the API
 *     endpoint is unreadable, so a key resolved through it renders as a broken
 *     image on every node that pins it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const envValues: Record<string, string> = {};

vi.mock("@core/config/env.js", () => ({
  env: new Proxy(
    {},
    {
      get: (_target, prop: string) => envValues[prop] ?? "",
    },
  ),
}));

const { r2ConfigFromEnv, s3ConfigFromEnv } = await import(
  "@core/infra/storage/s3.js"
);

beforeEach(() => {
  for (const key of Object.keys(envValues)) delete envValues[key];
});

describe("r2ConfigFromEnv", () => {
  it("carries the account-scoped endpoint the SDK cannot derive", () => {
    envValues.R2_BUCKET = "breatic-assets";
    envValues.R2_ACCESS_KEY = "key";
    envValues.R2_SECRET_KEY = "secret";
    envValues.R2_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    envValues.UPLOAD_BASE_URL = "https://cdn.example.com";

    const config = r2ConfigFromEnv();

    expect(config.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(config.bucket).toBe("breatic-assets");
    // R2 has one region and the SDK still demands the field; "auto" is the
    // value Cloudflare's own S3 API docs use.
    expect(config.region).toBe("auto");
  });

  it("reads objects back through the public base, never the API endpoint", () => {
    envValues.R2_BUCKET = "breatic-assets";
    envValues.R2_ACCESS_KEY = "key";
    envValues.R2_SECRET_KEY = "secret";
    envValues.R2_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    envValues.UPLOAD_BASE_URL = "https://cdn.example.com";

    expect(r2ConfigFromEnv().publicBaseUrl).toBe("https://cdn.example.com");
  });

  it("refuses to build without a public base — a signed URL is not readable", () => {
    envValues.R2_BUCKET = "breatic-assets";
    envValues.R2_ACCESS_KEY = "key";
    envValues.R2_SECRET_KEY = "secret";
    envValues.R2_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";

    expect(() => r2ConfigFromEnv()).toThrow(/UPLOAD_BASE_URL/);
  });

  it("refuses to build without an endpoint", () => {
    envValues.R2_BUCKET = "breatic-assets";
    envValues.R2_ACCESS_KEY = "key";
    envValues.R2_SECRET_KEY = "secret";
    envValues.UPLOAD_BASE_URL = "https://cdn.example.com";

    expect(() => r2ConfigFromEnv()).toThrow(/R2_S3_ENDPOINT/);
  });

  it("names every missing credential at once", () => {
    envValues.R2_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    envValues.UPLOAD_BASE_URL = "https://cdn.example.com";

    expect(() => r2ConfigFromEnv()).toThrow(/R2_BUCKET/);
  });
});

describe("s3ConfigFromEnv", () => {
  it("keeps the regional AWS default when no public base is configured", () => {
    envValues.S3_BUCKET = "legacy";
    envValues.S3_REGION = "us-east-1";
    envValues.S3_ACCESS_KEY = "key";
    envValues.S3_SECRET_KEY = "secret";

    const config = s3ConfigFromEnv();

    // Unlike R2 this one CAN fall back: an AWS bucket is publicly addressable
    // at its own regional hostname, so a missing base is not a broken URL.
    expect(config.publicBaseUrl).toBe("https://legacy.s3.us-east-1.amazonaws.com");
    expect(config.endpoint).toBeUndefined();
  });

  it("prefers a configured public base over the regional hostname", () => {
    envValues.S3_BUCKET = "legacy";
    envValues.S3_REGION = "us-east-1";
    envValues.S3_ACCESS_KEY = "key";
    envValues.S3_SECRET_KEY = "secret";
    envValues.UPLOAD_BASE_URL = "https://cdn.example.com";

    expect(s3ConfigFromEnv().publicBaseUrl).toBe("https://cdn.example.com");
  });
});
