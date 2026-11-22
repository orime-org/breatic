// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Stripe catch-up (inner#1993 §8.5 event K): after a stop, the events Stripe
 * holds from a lookback before the stop are listed, the ones already in the
 * processed set are skipped, and the rest go through the webhook's own path
 * in the order Stripe created them.
 */

import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { CATCH_UP_EVENT_TYPES, catchUpStripeEvents } from "@server/modules/stripe-webhook/catch-up.js";

/**
 * A minimal event.
 * @param id - Its id.
 * @param created - Its creation time, in seconds.
 * @returns The event.
 */
function event(id: string, created: number): Stripe.Event {
  return { id, created, type: "invoice.paid", livemode: false, data: { object: {} } } as unknown as Stripe.Event;
}

/**
 * The events as Stripe's list returns them: newest first.
 * @param events - The events.
 * @returns An async iterable over them.
 */
async function* listed(events: Stripe.Event[]): AsyncIterable<Stripe.Event> {
  for (const e of [...events].sort((a, b) => b.created - a.created)) yield e;
}

describe("catchUpStripeEvents", () => {
  it("lists the handled event types from the lookback before the stop", async () => {
    const listEvents = vi.fn(() => listed([]));
    const since = new Date("2026-11-20T10:00:00Z");
    await catchUpStripeEvents({ listEvents, processedIds: async () => new Set(), handle: vi.fn(), onFailed: vi.fn() }, since, 96);
    expect(listEvents).toHaveBeenCalledWith({
      types: CATCH_UP_EVENT_TYPES,
      createdGte: Math.floor(since.getTime() / 1000) - 96 * 3600,
    });
  });

  it("stays within Stripe's limit of 20 types per list call", () => {
    expect(CATCH_UP_EVENT_TYPES.length).toBeLessThanOrEqual(20);
  });

  it("skips processed events and handles the rest oldest first", async () => {
    const handle = vi.fn(async (_event: Stripe.Event) => ({ responseStatus: 200 }));
    const outcome = await catchUpStripeEvents(
      {
        listEvents: () => listed([event("evt_c", 30), event("evt_a", 10), event("evt_b", 20)]),
        processedIds: async (ids) => new Set(ids.filter((id) => id === "evt_b")),
        handle,
        onFailed: vi.fn(),
      },
      new Date(),
      96,
    );
    expect(handle.mock.calls.map(([e]) => e.id)).toEqual(["evt_a", "evt_c"]);
    expect(outcome).toEqual({ listed: 3, skipped: 1, handled: 2, failed: [] });
  });

  it("goes on past a failed event, names it and hands over why", async () => {
    const err = new Error("db down");
    const onFailed = vi.fn();
    const handle = vi.fn(async (e: Stripe.Event) => {
      if (e.id === "evt_a") return { responseStatus: 500 };
      if (e.id === "evt_b") throw err;
      return { responseStatus: 200 };
    });
    const outcome = await catchUpStripeEvents(
      {
        listEvents: () => listed([event("evt_a", 10), event("evt_b", 20), event("evt_c", 30)]),
        processedIds: async () => new Set(),
        handle,
        onFailed,
      },
      new Date(),
      96,
    );
    expect(handle).toHaveBeenCalledTimes(3);
    expect(onFailed.mock.calls).toEqual([["evt_a", { responseStatus: 500 }], ["evt_b", { err }]]);
    expect(outcome).toEqual({ listed: 3, skipped: 0, handled: 1, failed: ["evt_a", "evt_b"] });
  });
});
