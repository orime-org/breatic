// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The presence threshold is a claim about the browser, so this pins it to one.
 *
 * Nothing writes "offline" when a socket closes (see `hooks/presence.ts`), so a
 * record is turned off purely because its timestamp stopped moving. Every
 * heartbeat moves it — nothing else reaches the meta document's awareness
 * channel, so there is nothing to rate-limit and no beat is ever skipped. The threshold is
 * therefore a claim about ONE thing: the slowest rate at which a genuinely
 * connected browser beats. Set it under that rate and everyone with a hidden
 * tab flips off and on forever, and the mistake is invisible in every other
 * test because it lives between a config value and a browser behaviour rather
 * than inside any function.
 *
 * An awake tab beats every 18 seconds — measured in Chrome, three consecutive
 * gaps of 17981/18000/18000ms. y-protocols renews after 15 seconds of silence
 * but only checks on a 3-second tick, and the tick at 15 seconds lands a hair
 * under the mark every time, so it waits for the next one. The library's own
 * "every 15 seconds" is therefore a floor, not the interval.
 *
 * The rate that binds is slower still, and it is the surprising one. A tab
 * hidden for more than five minutes has its timers checked once a MINUTE
 * (Chrome 88 onward,
 * https://developer.chrome.com/blog/timer-throttling-in-chrome-88), while its
 * socket stays open the whole time because the keepalive pong is answered by
 * the network stack and never runs JavaScript. So "connected" and "beating"
 * are not the same rate, and the threshold has to be built for the slowest.
 */

import { describe, it, expect } from "vitest";

import { getCollabConfig } from "@collab/config";

/**
 * How often a browser renews its awareness clock while the tab is hidden and
 * its timers are throttled: the same renewal as an awake tab (measured at 18s),
 * seen through a once-a-minute timer. The widest gap a connected person can
 * show, and therefore the one number the threshold has to clear.
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
