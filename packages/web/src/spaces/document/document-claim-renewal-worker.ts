// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Web Worker that ticks every 15 seconds while this page claims an upload in
 * awareness (inner#1351 + inner#1390 design §5.5). A hidden tab's main-thread
 * timers fire at most once in 30 seconds after a while, which is y-protocols'
 * expiry (`awareness.js:13`); a worker's are not slowed (measured,
 * `2026-10-14-1351-worker-timer-throttling-nodebug-probe.mjs`). The page
 * renews its awareness on each tick.
 */

/** Half of y-protocols' 30-second expiry. */
const TICK_MS = 15_000;

setInterval(() => {
  self.postMessage(0);
}, TICK_MS);
