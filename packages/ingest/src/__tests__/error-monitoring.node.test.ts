// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import { monitoringOptions, noteFailure } from "@ingest/error-monitoring.js";

vi.mock("@sentry/cloudflare", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

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

  it("turns reporting off and says so once when the DSN is not a DSN", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(monitoringOptions({ SENTRY_DSN: "<the ingest DSN>" }).dsn).toBe("");
    expect(monitoringOptions({ SENTRY_DSN: "<the ingest DSN>" }).dsn).toBe("");

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("ingest_sentry_dsn_invalid", {});
    logged.mockRestore();
  });

  it("strips the query from the referring page each event carries", () => {
    const sent = monitoringOptions({ SENTRY_DSN: DSN }).beforeSend({
      request: { headers: { referer: "https://app.test/reset-password?token=R" } },
    });
    expect(sent.request?.headers).toEqual({ referer: "https://app.test/reset-password" });
  });
});

// inner#1595 B2: a failure that must leave a record every time it happens
// passes its own message and a fixed fingerprint, so the SDK's dedupe keeps
// each occurrence while Sentry groups them as one issue.
describe("noteFailure", () => {
  const LABEL = "ingest_open_without_secret";
  const CTX = { storageKey: "k-1", userId: "u-1", studioId: "s-1", requestId: "r-1" };

  beforeEach(() => {
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.captureException).mockClear();
  });

  it("T89: reports a per-occurrence failure under its own message and a fixed fingerprint", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    noteFailure(LABEL, CTX, undefined, {
      perOccurrence: { message: `${LABEL} k-1 r-1`, fingerprint: [LABEL] },
    });

    expect(Sentry.captureMessage).toHaveBeenCalledExactlyOnceWith(`${LABEL} k-1 r-1`, {
      level: "error",
      tags: { label: LABEL },
      contexts: { ingest: CTX },
      fingerprint: [LABEL],
    });
    expect(logged).toHaveBeenCalledExactlyOnceWith(LABEL, CTX);
    logged.mockRestore();
  });

  it("T89: leaves every other failure's message as its label, with no fingerprint", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    noteFailure("ingest_source_refused", { storageKey: "k-1" });

    expect(vi.mocked(Sentry.captureMessage).mock.calls).toStrictEqual([
      ["ingest_source_refused", { level: "error", tags: { label: "ingest_source_refused" }, contexts: { ingest: { storageKey: "k-1" } } }],
    ]);
    logged.mockRestore();
  });

  it("T89: reports nothing for the reader's own input, whatever else it passes", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    noteFailure(LABEL, CTX, undefined, {
      userInput: true,
      perOccurrence: { message: `${LABEL} k-1 r-1`, fingerprint: [LABEL] },
    });

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledExactlyOnceWith(LABEL, CTX);
    logged.mockRestore();
  });
});
