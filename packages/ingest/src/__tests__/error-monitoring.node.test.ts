// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { monitoringOptions } from "@ingest/error-monitoring.js";

const DSN = "https://publickey@sentry.test.example/1";
const SHA = "4ca3e774ad2bb6b8f9406579ddc4bb611e5037a0";

describe("monitoringOptions", () => {
  it("carries the deployment's DSN, release and environment", () => {
    expect(
      monitoringOptions({ SENTRY_DSN: DSN, SENTRY_RELEASE: SHA, SENTRY_ENVIRONMENT: "staging" }),
    ).toMatchObject({ dsn: DSN, release: SHA, environment: "staging" });
  });

  it("hands the SDK an empty DSN, which sends nothing, when none is configured", () => {
    expect(monitoringOptions({}).dsn).toBe("");
    expect(monitoringOptions({ SENTRY_DSN: "" }).dsn).toBe("");
    expect(monitoringOptions({ SENTRY_DSN: ` ${DSN}\n` }).dsn).toBe(DSN);
  });

  it("always names a release key, leaving it unset when it is not a full commit", () => {
    const options = monitoringOptions({ SENTRY_DSN: DSN, SENTRY_RELEASE: "unknown" });
    expect(options).toHaveProperty("release", undefined);
    expect(monitoringOptions({ SENTRY_DSN: DSN })).toHaveProperty("release", undefined);
  });

  it("names the environment development when it is missing or not a shared name", () => {
    expect(monitoringOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "prod" }).environment).toBe("development");
    expect(monitoringOptions({ SENTRY_DSN: DSN }).environment).toBe("development");
  });

  it("collects no user details, cookies, bodies or query strings", () => {
    expect(monitoringOptions({ SENTRY_DSN: DSN }).dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
    });
  });
});
