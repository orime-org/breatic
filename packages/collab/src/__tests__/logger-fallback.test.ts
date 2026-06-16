// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Tests for the pino-transport error fallback.
 *
 * Regression target: collab ran 2026-06-01 → 06-16 with dead file
 * logging because the pino transport worker thread errored and — with
 * no `error` listener — died silently. This fallback makes such a death
 * loud, so the assertions here pin that an emitted transport error
 * reaches the fallback sink.
 */

import { describe, it, expect, vi } from "vitest";
import { attachTransportErrorFallback } from "@collab/infra/logger-fallback.js";

describe("attachTransportErrorFallback", () => {
  it("writes a loud fallback line when the transport emits 'error'", () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const transport = {
      on: (ev: "error", cb: (e: unknown) => void): void => {
        listeners[ev] = cb;
      },
    };
    const written: string[] = [];

    attachTransportErrorFallback(transport, (line) => written.push(line));
    expect(written).toHaveLength(0); // silent until an error actually fires

    listeners.error?.(new Error("pino-roll reopen EACCES"));
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("pino-roll reopen EACCES");
    expect(written[0]).toMatch(/transport/i);
  });

  it("subscribes specifically to the 'error' event", () => {
    const on = vi.fn();
    attachTransportErrorFallback({ on }, () => {});
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("stringifies non-Error throwables without crashing", () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const transport = {
      on: (ev: "error", cb: (e: unknown) => void): void => {
        listeners[ev] = cb;
      },
    };
    const written: string[] = [];

    attachTransportErrorFallback(transport, (line) => written.push(line));
    listeners.error?.("disk full");
    expect(written[0]).toContain("disk full");
  });
});
