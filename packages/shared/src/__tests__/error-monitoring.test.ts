// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import {
  errorMonitoringDataCollection,
  errorMonitoringEnvironmentName,
  errorMonitoringRelease,
  isSentryDsn,
} from "@shared/error-monitoring.js";

const SHA = "4ca3e774ad2bb6b8f9406579ddc4bb611e5037a0";

describe("errorMonitoringRelease", () => {
  it("takes a full lowercase commit hash", () => {
    expect(errorMonitoringRelease(SHA)).toBe(SHA);
  });

  it("takes nothing else", () => {
    expect(errorMonitoringRelease("unknown")).toBeUndefined();
    expect(errorMonitoringRelease(SHA.slice(0, 7))).toBeUndefined();
    expect(errorMonitoringRelease(SHA.toUpperCase())).toBeUndefined();
    expect(errorMonitoringRelease(`${SHA}\n`)).toBeUndefined();
    expect(errorMonitoringRelease("")).toBeUndefined();
    expect(errorMonitoringRelease(undefined)).toBeUndefined();
    expect(errorMonitoringRelease(42)).toBeUndefined();
  });
});

describe("errorMonitoringEnvironmentName", () => {
  it("takes the three shared environment names", () => {
    expect(errorMonitoringEnvironmentName("production")).toBe("production");
    expect(errorMonitoringEnvironmentName("staging")).toBe("staging");
    expect(errorMonitoringEnvironmentName("development")).toBe("development");
  });

  it("takes nothing else", () => {
    expect(errorMonitoringEnvironmentName("prod")).toBeUndefined();
    expect(errorMonitoringEnvironmentName("Production")).toBeUndefined();
    expect(errorMonitoringEnvironmentName("")).toBeUndefined();
    expect(errorMonitoringEnvironmentName(undefined)).toBeUndefined();
  });
});

describe("errorMonitoringDataCollection", () => {
  it("collects no user details, cookies, bodies, query strings or identifying headers", () => {
    expect(errorMonitoringDataCollection()).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: ["forwarded", "-ip", "remote-", "via", "-user", "ticket", "signature"] },
        response: { deny: ["forwarded", "-ip", "remote-", "via", "-user", "ticket", "signature"] },
      },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      graphQL: { document: false, variables: false },
    });
  });

  it("filters the credential headers the SDKs' own list does not name", () => {
    const deny = errorMonitoringDataCollection().httpHeaders.request.deny;
    // x-upload-ticket (ingest) and stripe-signature (server webhooks).
    expect(deny).toEqual(expect.arrayContaining(["ticket", "signature"]));
  });

  it("hands every caller its own object", () => {
    const first = errorMonitoringDataCollection();
    first.httpHeaders.request.deny.push("x-test");
    expect(errorMonitoringDataCollection().httpHeaders.request.deny).not.toContain("x-test");
  });
});

describe("isSentryDsn", () => {
  it("takes a DSN with a public key and a numeric project", () => {
    expect(isSentryDsn("https://publickey@o1.ingest.sentry.io/2")).toBe(true);
    expect(isSentryDsn("http://publickey@127.0.0.1:9411/3")).toBe(true);
    expect(isSentryDsn("https://publickey@sentry.example.com/path/42")).toBe(true);
  });

  it("refuses anything the SDK would refuse", () => {
    expect(isSentryDsn("<the ingest Sentry project's DSN, or empty>")).toBe(false);
    expect(isSentryDsn("https://o1.ingest.sentry.io/2")).toBe(false);
    expect(isSentryDsn("https://public-key@o1.ingest.sentry.io/2")).toBe(false);
    expect(isSentryDsn("https://publickey@o1.ingest.sentry.io/project")).toBe(false);
    expect(isSentryDsn("ftp://publickey@o1.ingest.sentry.io/2")).toBe(false);
    expect(isSentryDsn(" https://publickey@o1.ingest.sentry.io/2")).toBe(false);
    expect(isSentryDsn("")).toBe(false);
  });
});
