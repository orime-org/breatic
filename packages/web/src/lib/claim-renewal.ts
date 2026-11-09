// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Ticks on a Worker's timer, which a hidden tab does not slow, so a page keeps renewing the awareness claims it
 * publishes for its uploads before y-protocols' 30-second expiry (inner#1351 + inner#1390 design §5.5).
 * @param tick - Called on each tick.
 * @returns What stops the timer.
 * @throws {never} Never.
 */
export function renewOnWorker(tick: () => void): () => void {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./claim-renewal-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    // ponytail: main-thread fallback, throttled to once in 30 s+ when hidden.
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }
  worker.onmessage = tick;
  return () => worker.terminate();
}
