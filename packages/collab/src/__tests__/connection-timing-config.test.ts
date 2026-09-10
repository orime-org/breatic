// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Two expiries, one knob.
 *
 * A seat and a presence record both answer the same question — is this
 * connection still there — so both are believed for as long as the transport
 * takes to notice it is not. That is two ping periods: one ping can be missed
 * for reasons that are not death (a slow hop, a paused process), two in a row
 * is the transport's own verdict, and it terminates the socket on it.
 *
 * Deriving both from the ping period rather than writing two numbers is what
 * keeps them in step. The pair used to be a browser claim instead — the
 * presence threshold was sized against how often a hidden tab's JavaScript
 * timers fire — and that claim was load-bearing in a way nothing checked:
 * hidden tabs are throttled to about once a minute (Chrome 88 onward,
 * https://developer.chrome.com/blog/timer-throttling-in-chrome-88) while the
 * socket underneath stays open the whole time. A protocol pong carries no such
 * risk: the browser's network stack answers it and JavaScript never runs, so a
 * backgrounded tab keeps the same rhythm as a foreground one.
 */

import { describe, it, expect } from "vitest";

import { getCollabConfig, getConnectionTimings } from "@collab/config";

describe("connection timing", () => {
  // The SHIPPED values, read from config/collab.yaml the way production reads
  // them — not the schema defaults. Someone tuning the yaml is exactly who
  // this needs to stop, and a schema default would sail past that edit
  // untouched.
  const shipped = getCollabConfig();

  it("declares the interval the transport actually pings at", () => {
    // crossws hard-codes 30s and hocuspocus does not forward its idleTimeout,
    // so this key is a DECLARATION about the transport, not a knob that can
    // change it. An integration test measures the real interval; if that ever
    // diverges from this number, the two expiries below are sized for a rhythm
    // that no longer exists.
    expect(shipped.connection_ping_interval_ms).toBe(30_000);
  });

  it("believes a seat for two ping periods", () => {
    expect(getConnectionTimings().seatExpiryMs).toBe(
      shipped.connection_ping_interval_ms * 2,
    );
  });

  it("believes a presence record for two ping periods", () => {
    expect(getConnectionTimings().presenceStaleAfterMs).toBe(
      shipped.connection_ping_interval_ms * 2,
    );
  });

  it("passes the declared interval through untouched", () => {
    expect(getConnectionTimings().pingIntervalMs).toBe(
      shipped.connection_ping_interval_ms,
    );
  });

  it("has no second expiry knob to keep in step with this one", () => {
    // A standalone threshold used to sit in the yaml, and sizing it correctly
    // meant reasoning about browser timer throttling every time somebody
    // touched it. Both expiries are derived now; a hand-written millisecond
    // ceiling reappearing here would be one that nothing keeps in step with
    // the ping period.
    const handWrittenExpiries = Object.keys(shipped).filter((k) =>
      /_stale_|_expiry_|_timeout_ms$/.test(k),
    );
    expect(handWrittenExpiries).toEqual(["store_alert_timeout_ms"]);
  });
});
