// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What `downloadToTempDir` tells the shared transport.
 *
 * This helper feeds every local ffmpeg handler its input asset, and until
 * this migration it called `fetch` bare: one delivery, no retry of its own.
 * A blip was not fatal even then — BullMQ re-runs the whole job three times
 * and the canvas stays quiet until the last attempt — but recovering meant
 * re-running everything, re-transcode included, and only within BullMQ's
 * ~12s jittered window. Declaring the download replay-safe moves the retry
 * to where the failure is: a pure GET, so replaying it costs nothing.
 *
 * Behavioural rather than structural because no reading of the call site
 * can show what actually reaches the transport, and `replaySafe` is the one
 * value that decides whether the retry happens at all.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as sharedModule from "@breatic/shared";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

import { downloadToTempDir } from "@worker/handlers/local/runtime/download.js";

let tempDir: string;

describe("downloadToTempDir hands the request to the shared transport", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "download-forwarding-"));
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(
      async () => new Response("video bytes", { status: 200 }),
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("declares the download replay-safe, which is what earns the retry", async () => {
    await downloadToTempDir("https://storage.test/clip.mp4", tempDir);

    // Strict equality: no deadline belongs here (file sizes vary without
    // bound and nothing today caps the total), and replaySafe flipping to
    // false would silently take the retry away again.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]![0]).toBe("https://storage.test/clip.mp4");
    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({ replaySafe: true });
  });

  it("still streams the body to disk and returns the path", async () => {
    // The migration touches the one line that fetches; everything about
    // writing the file must come through unchanged.
    const path = await downloadToTempDir("https://storage.test/clip.mp4", tempDir);

    expect(path.startsWith(tempDir)).toBe(true);
    expect(path.endsWith(".mp4")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("video bytes");
  });

  it("still reports a non-ok status with the url and code", async () => {
    httpRequestMock.mockImplementation(
      async () => new Response("nope", { status: 404 }),
    );

    await expect(
      downloadToTempDir("https://storage.test/gone.mp4", tempDir),
    ).rejects.toThrow(/gone\.mp4.*404/);
  });
});
