// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The process-wide dispatcher the worker and server install (inner#1367
 * §4.8c): waiting for an answer to start is bounded by each caller's deadline,
 * and reading the answer keeps undici's own idle window (A13). undici reads
 * `headersTimeout: 0` as no limit and defaults `bodyTimeout` to 300 s.
 */

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options?: ConstructorParameters<typeof actual.Agent>[0]) {
        super(options);
        h.options.push(options);
      }
    },
  };
});

import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

import { installDeadlineBoundDispatcher } from "@core/infra/idle-socket-dispatcher.js";

describe("installDeadlineBoundDispatcher", () => {
  it("switches off undici's wait for headers and leaves its body window as it is", () => {
    const before = getGlobalDispatcher();
    try {
      installDeadlineBoundDispatcher();
      expect(h.options).toEqual([{ headersTimeout: 0 }]);
    } finally {
      setGlobalDispatcher(before);
    }
  });
});
