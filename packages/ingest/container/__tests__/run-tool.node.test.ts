// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the media container hands a tool its input and collects the answer
 * (inner#1320 round 5). `cat` and `head` stand in for vips: what is under
 * test is the wiring around the program, not the program.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { runTool } from "../run-tool.js";

const BYTES = new TextEncoder().encode("abc");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a source that breaks off", () => {
  // A read cut off mid-body ends the input short. A decoder fed a short
  // picture still writes one, grey where the bytes stopped, so nothing the
  // tool writes from such an input is kept.
  it("gives no answer instead of the tool's output on what arrived", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES);
        setTimeout(() => controller.error(new Error("cut off")), 20);
      },
    });

    expect(await runTool("cat", [], { maxBytes: 1024, signal: AbortSignal.timeout(5_000), input: source })).toBeNull();
  });
});

describe("a tool that stops reading early", () => {
  it("answers with its output and lets go of the source", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    const out = await runTool("head", ["-c", "1"], {
      maxBytes: 1024,
      signal: AbortSignal.timeout(5_000),
      input: source,
    });

    expect(out?.length).toBe(1);
    await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 2_000 });
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("a deadline that has already passed", () => {
  it("gives no answer and does not throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runTool("cat", [], { maxBytes: 1024, signal: AbortSignal.abort(), input: BYTES })).resolves.toBeNull();
  });
});
