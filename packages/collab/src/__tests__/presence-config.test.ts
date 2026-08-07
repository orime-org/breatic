// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The presence threshold is a claim about the browser, so this pins it to one.
 *
 * Nothing writes "offline" when a socket closes (see `hooks/presence.ts`), so a
 * record is turned off purely because its timestamp stopped moving. Every
 * heartbeat moves it — the meta document carries no other client traffic, so
 * there is nothing to rate-limit and no beat is ever skipped. The threshold is
 * therefore a claim about ONE thing: the slowest rate at which a genuinely
 * connected browser beats. Set it under that rate and everyone with a hidden
 * tab flips off and on forever, and the mistake is invisible in every other
 * test because it lives between a config value and a browser behaviour rather
 * than inside any function.
 *
 * The rate that binds is the surprising one. A tab hidden for more than five
 * minutes has its timers checked once a MINUTE (Chrome 88 onward,
 * https://developer.chrome.com/blog/timer-throttling-in-chrome-88), while its
 * socket stays open the whole time because the keepalive pong is answered by
 * the network stack and never runs JavaScript. So "connected" and "beating
 * every 15 seconds" are not the same thing, and the threshold has to be built
 * for the slower one.
 */

import { describe, it, expect } from "vitest";

import { getCollabConfig } from "@collab/config";

/**
 * How often a browser renews its awareness clock while the tab is hidden and
 * its timers are throttled. The library renews after 15s of silence, so an
 * awake tab beats every 15s; this is that same renewal seen through a
 * once-a-minute timer, and it is the widest gap a connected person can show.
 */
const BACKGROUND_BEAT_MS = 60_000;

describe("presence threshold", () => {
  // The SHIPPED value, read from config/collab.yaml the way production reads
  // it — not the schema default. Someone tuning the yaml is exactly who this
  // needs to stop, and a schema default would sail past that edit untouched.
  const shipped = getCollabConfig();

  it("believes an online record for longer than a hidden tab takes to beat", () => {
    // The failure this catches: a threshold at or below 60s sits exactly on the
    // hidden-tab cycle, so a connected person is swept every minute and revived
    // by their next beat — visible churn, from a number that looks reasonable.
    expect(shipped.presence_stale_after_ms).toBeGreaterThan(BACKGROUND_BEAT_MS);
  });

  it("keeps enough margin to absorb propagation and timer jitter", () => {
    // Half again over the widest beat. Not a preference: at 1.0 the threshold
    // IS the gap, so any delay in reaching another instance through the shared
    // document pushes a live record over it.
    expect(shipped.presence_stale_after_ms).toBeGreaterThanOrEqual(
      BACKGROUND_BEAT_MS * 1.5,
    );
  });

  it("has no second presence knob to keep in step with this one", () => {
    // A write throttle used to sit beside this number, and the arithmetic tying
    // the two together was wrong twice. It was removed rather than corrected:
    // the meta document only ever carries heartbeats, so there was never any
    // traffic for it to limit. This asserts it has not come back — a throttle
    // reintroduced here would silently widen the gap between two writes past
    // what the threshold above is sized for.
    expect(Object.keys(shipped).filter((k) => k.startsWith("presence_"))).toEqual(
      ["presence_stale_after_ms"],
    );
  });
});
