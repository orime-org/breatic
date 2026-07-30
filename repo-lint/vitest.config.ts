// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // These checks drive real tools — the secret scanner, the documentation
    // resolver, git — so a case here costs whatever the operating system
    // charges to start a child and schedule it, not whatever the assertion
    // costs. Sixteen packages test at once on a machine with fewer cores
    // than that, so the child waits. Measured: comfortably under a tenth of
    // a second idle, past the five-second default under a full parallel
    // run. Holding a test that spawns a process to a limit meant for
    // in-memory assertions buys a suite that goes red at random for a
    // reason that has nothing to do with the code — which is how a real
    // failure ends up dismissed as noise. High enough to absorb a starved
    // scheduler, low enough that something genuinely hung still reports.
    testTimeout: 60_000,
  },
});
