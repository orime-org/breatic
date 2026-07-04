// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

// Test setup — load env vars

import { vi } from "vitest";

// Unit tests mock `@breatic/core` with `MONOREPO_ROOT="/tmp"`, so any
// config loader that `readFileSync`s from `config/` would ENOENT.
// Stub the rate-limits loader globally with permissive windows —
// WHETHER a request is throttled is governed by the mocked
// `core.checkRateLimit` (see mock-core / auth.ratelimit.test), so this
// only supplies the `{max, windowSeconds}` numbers without a file read.
vi.mock("@server/config/rate-limits.js", () => ({
  getRateLimit: () => ({ max: 1000, windowSeconds: 60 }),
}));
