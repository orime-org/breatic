// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// Test setup — load env vars

import { afterAll, vi } from "vitest";

// Stub the rate-limits loader globally with permissive windows —
// WHETHER a request is throttled is governed by the mocked
// `core.checkRateLimit` (see mock-core / auth.ratelimit.test), so this
// only supplies the `{max, windowSeconds}` numbers without a file read.
vi.mock("@server/config/rate-limits.js", () => ({
  getRateLimit: () => ({ max: 1000, windowSeconds: 60 }),
}));

// The run-once lease loader reads `config/idempotency.yaml` the same way; the
// lease length only matters to the Redis-backed integration suite.
vi.mock("@server/config/idempotency.js", () => ({
  getRunningLeaseMs: () => 30_000,
}));

// A file's stubbed globals end with the file. Every file in this package runs
// in one process, and a stub left standing reaches the next file as it imports
// its modules (in @breatic/web, a test that replaced `URL` with an object made
// the next file's `new URL(...)` at import time throw "URL is not a
// constructor").
afterAll(() => {
  vi.unstubAllGlobals();
});
