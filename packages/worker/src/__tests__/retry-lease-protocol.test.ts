// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Retry × lease protocol (#1580 adversarial fixes).
 *
 * The worker must emit a lease CLOSE (state:'idle' + handlingBy:null) ONLY
 * on a TERMINAL failure. A retryable failure that closes the lease
 * self-fences the successful retry: the retry reuses the same gen from the
 * job payload, the collab CAS finds no live lease, and the billed result
 * never lands on the node. `isTerminalAttempt` is the gate.
 *
 * BullMQ 5.30 semantics (source-verified): `attemptsStarted` increments
 * when processing starts (attempt N has attemptsStarted === N);
 * `opts.attempts` is the total allowance. Terminal ⇔ this started attempt
 * is the last allowed one.
 */

import { vi, describe, it, expect } from "vitest";

const mockPublishNodeEvent = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  publishNodeEvent: mockPublishNodeEvent,
  getStreamRedis: vi.fn(),
  getRedis: vi.fn(),
  env: { ENV: "test", CREDIT_MULTIPLIER: 1 },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  downloadAndStore: vi.fn(),
  getStorageAdapter: vi.fn(),
  storageKey: vi.fn(),
}));
vi.mock("@breatic/domain", () => ({
  taskService: {},
  creditService: {},
  nodeHistoryService: {},
  getModel: vi.fn(),
  buildToolSet: vi.fn(),
  getSkillRegistry: vi.fn(),
  extractPromptText: vi.fn(),
  verifyCanvasNodeLock: vi.fn(),
  releaseCanvasNodeLock: vi.fn(),
  reacquireCanvasNodeLock: vi.fn(),
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (pid: string, sid: string) => `project-${pid}/canvas-${sid}`,
}));
vi.mock("../mini-tool-registry.js", () => ({ resolveMiniToolEntry: vi.fn() }));
vi.mock("../handlers/local/index.js", () => ({ runLocalHandler: vi.fn() }));
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
}));

import { isTerminalAttempt } from "../handlers/dispatch.js";

describe("isTerminalAttempt (#1580 adversarial: retryable close self-fences the retry)", () => {
  it("attempt 1 of 3 is NOT terminal — no lease close may be emitted", () => {
    expect(
      isTerminalAttempt({ attemptsStarted: 1, opts: { attempts: 3 } }),
    ).toBe(false);
  });

  it("attempt 2 of 3 is NOT terminal", () => {
    expect(
      isTerminalAttempt({ attemptsStarted: 2, opts: { attempts: 3 } }),
    ).toBe(false);
  });

  it("attempt 3 of 3 IS terminal — the failure close is allowed", () => {
    expect(
      isTerminalAttempt({ attemptsStarted: 3, opts: { attempts: 3 } }),
    ).toBe(true);
  });

  it("a job with no retry allowance (attempts absent = 1) is terminal on attempt 1", () => {
    expect(isTerminalAttempt({ attemptsStarted: 1, opts: {} })).toBe(true);
  });

  it("defensive: missing attemptsStarted treats the attempt as terminal (never suppress the only close)", () => {
    // If BullMQ ever stops populating attemptsStarted, suppressing the
    // close would strand nodes until the sweeper; emitting a possibly-early
    // close is the safer failure mode (the QueueEvents net + CAS dedup it).
    expect(isTerminalAttempt({ opts: { attempts: 3 } } as never)).toBe(true);
  });
});
