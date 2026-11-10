// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A turn's cleanup runs no matter how the turn ends.
 *
 * The cleanup used to sit after the streaming loop, where every early exit
 * skipped it -- the reply was never saved and billing never ran.
 *
 * An async generator stops where its consumer stopped it, so a consumer that
 * walks away skips everything after the loop too. That exit is written for
 * rather than observed: measured on this stack, hono's `StreamingApi.write`
 * swallows the write error, so the SSE route never breaks out of its loop and
 * never calls `.return()` at all.
 *
 * Measured before writing any of this: a generator whose cleanup sits after
 * the loop runs none of it when the consumer breaks early, while the same
 * cleanup in a `finally` or in an outer plain function runs to completion,
 * `await` included.
 */
import { describe, expect, it, vi } from "vitest";
import { finalizeTurn } from "@domain/agent/turn-finalizer.js";

/** Records which steps ran, in order. */
function recorder() {
  const ran: string[] = [];
  return {
    ran,
    steps: {
      persist: vi.fn(async () => {
        await Promise.resolve();
        ran.push("persist");
      }),
      bill: vi.fn(async () => {
        await Promise.resolve();
        ran.push("bill");
      }),
    },
  };
}

describe("finalizeTurn", () => {
  it("is a plain async function, not a generator", async () => {
    // The shape is the invariant. The defect being fixed is precisely that a
    // generator's body stops when the consumer returns, so cleanup written
    // as a generator would move the bug rather than remove it. A yield*
    // delegation that never runs is indistinguishable from success.
    const result = finalizeTurn({ steps: {} });
    expect(typeof (result as { then?: unknown }).then).toBe("function");
    expect(
      (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator],
    ).toBeUndefined();
    await result;
  });

  it("charges before it saves the reply", async () => {
    // inner#1617: the charge request is the turn's earliest durable record,
    // so it is written before any other write of the turn.
    const { ran, steps } = recorder();
    await finalizeTurn({ steps });
    expect(ran).toEqual(["bill", "persist"]);
  });

  it("still saves the reply when billing throws", async () => {
    // Cleanup is independent obligations, not a transaction. Losing the
    // reply because the charge failed would trade one missing thing for a
    // worse one.
    const { ran, steps } = recorder();
    const boom = new Error("the database is down");
    const failures = await finalizeTurn({
      steps: {
        ...steps,
        bill: vi.fn(async () => {
          await Promise.resolve();
          throw boom;
        }),
      },
    });
    expect(ran).toEqual(["persist"]);
    expect(failures).toEqual([{ step: "bill", error: boom }]);
  });

  it("still charges when saving the reply throws", async () => {
    const { ran, steps } = recorder();
    const failing = {
      ...steps,
      persist: vi.fn(async () => {
        await Promise.resolve();
        throw new Error("the database is down");
      }),
    };
    await finalizeTurn({ steps: failing });
    expect(ran).toEqual(["bill"]);
  });

  it("reports both failures in the order it tried them", async () => {
    const billErr = new Error("charge failed");
    const persistErr = new Error("save failed");
    const failures = await finalizeTurn({
      steps: {
        persist: vi.fn(async () => { throw persistErr; }),
        bill: vi.fn(async () => { throw billErr; }),
      },
    });
    expect(failures).toEqual([
      { step: "bill", error: billErr },
      { step: "persist", error: persistErr },
    ]);
  });

  it("reports what failed instead of swallowing it", async () => {
    const { steps } = recorder();
    const boom = new Error("the database is down");
    const failures = await finalizeTurn({
      steps: { ...steps, persist: vi.fn(async () => { throw boom; }) },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.step).toBe("persist");
    expect(failures[0]?.error).toBe(boom);
  });

  it("returns an empty failure list when everything worked", async () => {
    const { steps } = recorder();
    expect(await finalizeTurn({ steps })).toEqual([]);
  });

  it("accepts a caller that only has some of the steps", async () => {
    // Worker runs an agent loop with no conversation and no SSE, so it has
    // nothing to persist. It declares what it has rather than passing
    // no-ops, and the finalizer does not care.
    const ran: string[] = [];
    await finalizeTurn({
      steps: { bill: async () => { ran.push("bill"); } },
    });
    expect(ran).toEqual(["bill"]);
  });
});
