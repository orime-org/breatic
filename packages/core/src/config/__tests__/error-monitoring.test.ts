// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  errorMonitoringEnvironment,
  errorMonitoringOptions,
  readBuildRelease,
} from "@core/config/error-monitoring.js";

const SHA = "4ca3e774ad2bb6b8f9406579ddc4bb611e5037a0";

/**
 * Write a build-info file into a fresh directory.
 * @param body - File contents.
 * @returns Path to the written file.
 */
function buildInfo(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "build-info-"));
  const path = join(dir, "build-info.json");
  writeFileSync(path, body);
  return path;
}

describe("errorMonitoringEnvironment", () => {
  it("names each deployment the way the web and ingest projects do", () => {
    expect(errorMonitoringEnvironment("prod")).toBe("production");
    expect(errorMonitoringEnvironment("staging")).toBe("staging");
    expect(errorMonitoringEnvironment("dev")).toBe("development");
  });
});

describe("readBuildRelease", () => {
  it("returns the commit the image was built from", () => {
    const path = buildInfo(JSON.stringify({ releaseVersion: "0.2.0", revision: SHA }));
    expect(readBuildRelease(path)).toBe(SHA);
  });

  it("returns nothing for an image built outside the release pipeline", () => {
    const path = buildInfo(JSON.stringify({ releaseVersion: "0.0.0-dev", revision: "unknown" }));
    expect(readBuildRelease(path)).toBeUndefined();
  });

  it("returns nothing when the revision is not a full commit hash", () => {
    expect(readBuildRelease(buildInfo(JSON.stringify({ revision: SHA.slice(0, 7) })))).toBeUndefined();
    expect(readBuildRelease(buildInfo(JSON.stringify({ revision: SHA.toUpperCase() })))).toBeUndefined();
    expect(readBuildRelease(buildInfo(JSON.stringify({ revision: 42 })))).toBeUndefined();
    expect(readBuildRelease(buildInfo(JSON.stringify({})))).toBeUndefined();
  });

  it("returns nothing when the file is absent or unreadable", () => {
    expect(readBuildRelease(join(tmpdir(), "no-such-dir", "build-info.json"))).toBeUndefined();
    expect(readBuildRelease(buildInfo("{not json"))).toBeUndefined();
  });
});

describe("errorMonitoringOptions", () => {
  const releasePath = (): string => buildInfo(JSON.stringify({ revision: SHA }));

  it("turns monitoring off when no DSN is configured", () => {
    expect(
      errorMonitoringOptions({ dsn: "", deployment: "prod", service: "server", buildInfoPath: releasePath() }),
    ).toBeNull();
  });

  it("tags the service and carries the release and environment", () => {
    const options = errorMonitoringOptions({
      dsn: "https://key@o1.ingest.sentry.io/2",
      deployment: "prod",
      service: "worker",
      buildInfoPath: releasePath(),
    });
    expect(options).toMatchObject({
      dsn: "https://key@o1.ingest.sentry.io/2",
      environment: "production",
      release: SHA,
      initialScope: { tags: { service: "worker" } },
    });
  });

  it("collects no user details, cookies, bodies or query strings", () => {
    const options = errorMonitoringOptions({
      dsn: "https://key@o1.ingest.sentry.io/2",
      deployment: "dev",
      service: "collab",
      buildInfoPath: releasePath(),
    });
    expect(options?.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
    });
  });

  it("leaves the release unset for an image built outside the release pipeline", () => {
    const options = errorMonitoringOptions({
      dsn: "https://key@o1.ingest.sentry.io/2",
      deployment: "staging",
      service: "server",
      buildInfoPath: buildInfo(JSON.stringify({ revision: "unknown" })),
    });
    expect(options).toHaveProperty("release", undefined);
  });

  it("strips the query from the referring page each event carries", () => {
    const options = errorMonitoringOptions({
      dsn: "https://key@o1.ingest.sentry.io/2",
      deployment: "prod",
      service: "server",
      buildInfoPath: releasePath(),
    });
    const sent = options?.beforeSend({
      request: { headers: { referer: "https://app.test/reset-password?token=R" } },
    });
    expect(sent?.request?.headers).toEqual({ referer: "https://app.test/reset-password" });
  });

  it("turns monitoring off for a DSN the SDK would not send to", () => {
    expect(
      errorMonitoringOptions({ dsn: "<backend DSN>", deployment: "prod", service: "server", buildInfoPath: releasePath() }),
    ).toBeNull();
  });
});
