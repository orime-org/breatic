// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shell's Sentry setup (#1599, design 9.4): the build-time DSN, the
 * options every brand reports with, which default integrations stay, and the
 * scrubbing that keeps addresses without their query and the home directory
 * out of every field the Electron SDK fills.
 */

import { describe, it, expect } from "vitest";
import { errorMonitoringDataCollection } from "@breatic/shared";

import {
  buildTimeCommit,
  buildTimeSentryDsn,
  desktopSentryOptions,
  keepsIntegration,
  scrubBreadcrumb,
  scrubEvent,
} from "@desktop/main/error-monitoring.js";

const DSN = "https://abc123@o1.ingest.sentry.io/42";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const HOME = "/Users/alice";

describe("buildTimeSentryDsn", () => {
  it("keeps a valid DSN", () => {
    expect(buildTimeSentryDsn(DSN, { release: true })).toBe(DSN);
  });

  it("leaves a development build without one", () => {
    expect(buildTimeSentryDsn("  ", { release: false })).toBe("");
  });

  it("fails a release build without a DSN, and any build with a malformed one", () => {
    expect(() => buildTimeSentryDsn("", { release: true })).toThrow(/BREATIC_DESKTOP_SENTRY_DSN/);
    expect(() => buildTimeSentryDsn("not-a-dsn", { release: false })).toThrow(/BREATIC_DESKTOP_SENTRY_DSN/);
  });
});

describe("buildTimeCommit", () => {
  it("keeps a full commit hash", () => {
    expect(buildTimeCommit(` ${COMMIT} `, { release: true })).toBe(COMMIT);
  });

  it("names a development build without one unknown", () => {
    expect(buildTimeCommit(undefined, { release: false })).toBe("unknown");
    expect(buildTimeCommit("abc123", { release: false })).toBe("unknown");
  });

  it("fails a release build without a full commit hash", () => {
    expect(() => buildTimeCommit(undefined, { release: true })).toThrow(/GITHUB_SHA/);
    expect(() => buildTimeCommit("abc123", { release: true })).toThrow(/GITHUB_SHA/);
  });
});

describe("desktopSentryOptions", () => {
  it("starts nothing without a DSN", () => {
    expect(desktopSentryOptions({ dsn: "", brandId: "breatic", packaged: true, commit: COMMIT })).toBeNull();
  });

  it("reports under the brand, the shared names and the build commit, through the classic IPC only", () => {
    const options = desktopSentryOptions({ dsn: DSN, brandId: "acme", packaged: true, commit: COMMIT });
    expect(options).toMatchObject({
      dsn: DSN,
      environment: "production",
      release: COMMIT,
      ipcMode: 1,
      attachScreenshot: false,
      initialScope: { tags: { brand: "acme" } },
    });
    expect(options?.dataCollection).toEqual(errorMonitoringDataCollection());
  });

  it("names a development build and drops a placeholder commit", () => {
    const options = desktopSentryOptions({ dsn: DSN, brandId: "breatic", packaged: false, commit: "unknown" });
    expect(options?.environment).toBe("development");
    expect(options?.release).toBeUndefined();
  });
});

describe("keepsIntegration", () => {
  it.each(["PreloadInjection", "Console"])("drops %s", (name) => {
    expect(keepsIntegration(name)).toBe(false);
  });

  it.each(["SentryMinidump", "MainProcessSession", "OnUncaughtException", "OnUnhandledRejection", "Pino"])("keeps %s", (name) => {
    expect(keepsIntegration(name)).toBe(true);
  });
});

describe("scrubEvent", () => {
  it("strips queries and the home directory from every field the SDK and our logs fill", () => {
    const event = scrubEvent(
      {
        exception: { values: [{ value: "ERR_FAILED (-2) loading 'https://studio.example.test/reset-password?token=SECRET'" }] },
        contexts: {
          pino: { url: "https://studio.example.test/x?token=SECRET#frag", msg: "server_load_failed" },
          electron: { crashed_url: "https://studio.example.test/project/1?invite=SECRET" },
        },
        extra: { path: `${HOME}/Library/Application Support/breatic/window-state.json` },
        request: { url: "https://studio.example.test/a?b=SECRET" },
      },
      HOME,
    );
    const text = JSON.stringify(event);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(HOME);
    expect(text).toContain("https://studio.example.test/reset-password");
    expect(text).toContain("~/Library/Application Support/breatic/window-state.json");
  });
});

describe("scrubBreadcrumb", () => {
  it("strips queries and the home directory from the message and the data", () => {
    const crumb = scrubBreadcrumb(
      { message: "navigate https://studio.example.test/x?token=SECRET", data: { url: "https://studio.example.test/y?token=SECRET", file: `${HOME}/a` } },
      HOME,
    );
    expect(JSON.stringify(crumb)).not.toContain("SECRET");
    expect(JSON.stringify(crumb)).not.toContain(HOME);
  });
});
