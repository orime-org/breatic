// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { noticeMatchesFfmpegPin } from "#repo-lint/checks/notice-matches-ffmpeg-pin";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * The Dockerfile line the pin lives on, with whatever version it names.
 *
 * The comment above it is the real file's: it names ffmpeg, carries no
 * version, and comes first, so a scan that reads the file as one string finds
 * it instead of the install.
 */
function dockerfile(version: string): string {
  return [
    "FROM node:22-slim AS runtime",
    "",
    "# ffmpeg for the worker's eight video mini-tools. Cover frames are the",
    "# media container's job, and #225 moves these eight there too.",
    "RUN apt-get update && apt-get install -y --no-install-recommends \\",
    `    ffmpeg=${version} \\`,
    "    && rm -rf /var/lib/apt/lists/*",
  ].join("\n");
}

/** The notice entry for that image, with whatever version it names. */
function notice(version: string): string {
  return [
    "### FFmpeg in the `breatic` image",
    "",
    `| Version | \`${version}\` — the epoch is Debian's |`,
    `| Origin | installed with \`apt-get install ffmpeg=${version}\` |`,
  ].join("\n");
}

const MATCHING = "7:5.1.9-0+deb12u1";

describe("notice-matches-ffmpeg-pin", () => {
  it("passes when the pin and the notice name one version", () => {
    const context = fakeContext({
      Dockerfile: dockerfile(MATCHING),
      "THIRD-PARTY.md": notice(MATCHING),
    });
    expect(noticeMatchesFfmpegPin.run(context)).toEqual([]);
  });

  it("reports a pin the notice does not name", () => {
    // The one that happens: a security update lands, the Dockerfile is bumped,
    // and the notice keeps offering source for a binary no image carries.
    const context = fakeContext({
      Dockerfile: dockerfile("7:5.1.10-0+deb12u1"),
      "THIRD-PARTY.md": notice(MATCHING),
    });
    const findings = noticeMatchesFfmpegPin.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("7:5.1.10-0+deb12u1");
    expect(findings[0]?.message).toContain(MATCHING);
  });

  it("reports an unpinned install", () => {
    const context = fakeContext({
      Dockerfile: [
        "FROM node:22-slim AS runtime",
        "RUN apt-get install -y --no-install-recommends ffmpeg",
      ].join("\n"),
      "THIRD-PARTY.md": notice(MATCHING),
    });
    const findings = noticeMatchesFfmpegPin.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("pin");
  });

  it("reports a Dockerfile that installs no ffmpeg at all", () => {
    const context = fakeContext({
      Dockerfile: "FROM node:22-slim AS runtime\nWORKDIR /app\n",
      "THIRD-PARTY.md": notice(MATCHING),
    });
    const findings = noticeMatchesFfmpegPin.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("no longer exists");
  });

  it("reports a notice that names no version for the image", () => {
    const context = fakeContext({
      Dockerfile: dockerfile(MATCHING),
      "THIRD-PARTY.md": "### FFmpeg in the `breatic` image\n\nNo table here.\n",
    });
    const findings = noticeMatchesFfmpegPin.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("THIRD-PARTY.md");
  });
});
