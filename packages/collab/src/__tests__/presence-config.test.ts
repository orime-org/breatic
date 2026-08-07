// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The two presence numbers are not independent, so this pins their relationship.
 *
 * Nothing writes "offline" when a socket closes (see `hooks/presence.ts`), so a
 * record is turned off purely because its timestamp stopped moving. That makes
 * the threshold a claim about the SLOWEST rate at which a genuinely connected
 * person refreshes it. Set it under that rate and everyone with a hidden tab
 * flips off and on forever; the mistake is invisible in every unit test,
 * because it lives in the gap between two numbers rather than in either one.
 *
 * The rate has two floors and the larger one wins:
 *
 *   - the server's own write throttle, plus one client beat to reach it
 *   - the browser's timer floor for a hidden tab, which is what actually binds
 *
 * The second is the one that surprises. A tab hidden for more than five minutes
 * has its timers checked once a MINUTE (Chrome 88 onward,
 * https://developer.chrome.com/blog/timer-throttling-in-chrome-88), while its
 * socket stays open the whole time because the keepalive pong is answered by
 * the network stack and never runs JavaScript. So "connected" and "beating
 * every 15 seconds" are not the same thing, and the threshold has to be built
 * for the slower one.
 */

import { describe, it, expect } from "vitest";

import { getCollabConfig } from "@collab/config";

/**
 * How often it renews while the tab is hidden and its timers are throttled.
 * This is the binding number: it is larger than the server's write throttle,
 * so it, not the throttle, decides how stale a connected person can look.
 */
const BACKGROUND_BEAT_MS = 60_000;

describe("presence thresholds", () => {
  // The SHIPPED values, read from config/collab.yaml the way production reads
  // them — not the schema defaults. Someone tuning the yaml is exactly who this
  // needs to stop, and a schema default would sail past that edit untouched.
  const defaults = getCollabConfig();

  it("believes an online record for longer than a hidden tab takes to beat", () => {
    // The failure this catches: a threshold at or below 60s sits exactly on the
    // hidden-tab cycle, so a connected person is swept every minute and revived
    // by their next beat — visible churn, from a number that looks reasonable.
    expect(defaults.presence_stale_after_ms).toBeGreaterThan(
      BACKGROUND_BEAT_MS,
    );
  });

  it("believes it for longer than the throttle can push a write out to", () => {
    // The throttle does not ADD to the beat, it SKIPS beats: a write lands on
    // the first beat at least a full window after the previous one. So the real
    // gap is the throttle rounded UP to a whole number of beats, and it jumps in
    // steps rather than growing smoothly.
    //
    // That distinction is the whole point of this case. Written as
    // "threshold > throttle + one beat" it looks right and is not: at a 70s
    // throttle the beat at 60s is skipped and the next write is at 120s, well
    // past a 90s threshold, while `70000 + 15000` sits comfortably under it and
    // the guard waves it through.
    const gapBetweenWrites =
      Math.ceil(defaults.presence_heartbeat_throttle_ms / BACKGROUND_BEAT_MS) *
      BACKGROUND_BEAT_MS;
    expect(defaults.presence_stale_after_ms).toBeGreaterThan(gapBetweenWrites);
  });

  it("keeps enough margin to absorb propagation and timer jitter", () => {
    // Half again over the real gap. Not a preference: at 1.0 the threshold IS
    // the gap, and any delay in reaching another instance through the shared
    // document pushes a live record over it.
    const gapBetweenWrites =
      Math.ceil(defaults.presence_heartbeat_throttle_ms / BACKGROUND_BEAT_MS) *
      BACKGROUND_BEAT_MS;
    expect(defaults.presence_stale_after_ms).toBeGreaterThanOrEqual(
      gapBetweenWrites * 1.5,
    );
  });
});
