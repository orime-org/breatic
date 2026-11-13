// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation job and its model-call registry (inner#1711 design §3.5, §6).
 *
 * `WebAnimationContainer` holds one job per job id and writes it only through `transitionWebAnimationJob`, the way
 * `MiniToolContainer` writes through `transition()`: the Durable Object stores the returned record in one write and
 * then carries out the effects. Its RPC methods map onto events one to one: `submit`, `cancel`, `beginModelCall`,
 * `recordModelCallStart`, `endModelCall`, the deadline alarm, the `r2.local` write, the `jobs.local` progress and
 * final reports, and the container stopping on its own.
 *
 * What these cases pin: one model call in flight per job; no new call once the job is stopping or ended; a cancel or
 * the deadline drains the call in flight before the container stops, and the stop, the terminal state and the frozen
 * call registry come back as one record; nothing written after the end changes the report; a crash marks open calls
 * cut_off; a cancel before any submit leaves a marker that refuses the submit until the cancel's deadline.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { webAnimationJobReportSchema, type WebAnimationJobReport, type WebAnimationJobRequest } from "@shared/upload/web-animation-job.js";
import type { Cost } from "@breatic/provider/messages";
import {
  reportOfWebAnimationJob,
  transitionWebAnimationJob,
  type WebAnimationJobEvent,
  type WebAnimationJobRecord,
  type WebAnimationTransition,
} from "@ingest/jobs/web-animation-transition.js";

const T0 = 1_794_000_000_000;

const REQUEST: WebAnimationJobRequest = {
  containerClass: "WebAnimationContainer",
  jobId: "timeline:40000000-0000-4000-8000-000000000001",
  deadlineAt: T0 + 7_200_000,
  prompt: "A red square slides from left to right",
  viewport: { width: 1920, height: 1080 },
  fps: { num: 24, den: 1 },
  durationFrames: 96,
  packageKey: "web-animation/p1/40000000-0000-4000-8000-000000000001/index.html",
  manifestKey: "web-animation/p1/40000000-0000-4000-8000-000000000001/manifest.json",
  fontSetVersion: 1,
  maxPackageBytes: 5_000_000,
  maxTokens: 32_000,
  callTimeoutMs: 300_000,
  model: "deepseek/deepseek-v4.1-flash-1017",
};

const TOKENS = { input: 41, output: 6, reasoning: 3, cacheRead: 128 };
const SHA = "a".repeat(64);

/**
 * Apply events in order, each one millisecond after the last.
 * @param record - Where to start.
 * @param events - What happens.
 * @returns Every transition's result, in order.
 */
function run(record: WebAnimationJobRecord | null, events: WebAnimationJobEvent[]): WebAnimationTransition[] {
  const results: WebAnimationTransition[] = [];
  let current = record;
  events.forEach((event, i) => {
    const next = transitionWebAnimationJob(current, event, T0 + 1 + i);
    results.push(next);
    current = next.record;
  });
  return results;
}

/**
 * The record after the given events.
 * @param events - What happens, starting from a fresh submit.
 * @returns The record.
 */
function after(events: WebAnimationJobEvent[]): WebAnimationJobRecord {
  const results = run(null, [{ type: "submit", request: REQUEST }, ...events]);
  const record = results.at(-1)!.record;
  if (record === null) throw new Error("the job vanished");
  return record;
}

/**
 * The report of a record, checked against the shared schema the worker parses.
 * @param record - The record.
 * @returns The report.
 */
function report(record: WebAnimationJobRecord | null): WebAnimationJobReport {
  const answer = reportOfWebAnimationJob(record);
  expect(answer).not.toBeNull();
  return webAnimationJobReportSchema.parse(answer);
}

const begin: WebAnimationJobEvent = { type: "beginModelCall" };

/**
 * A call's message_start.
 * @param seq - The call.
 * @returns The event.
 */
const started = (seq: number): WebAnimationJobEvent => ({ type: "recordModelCallStart", seq, upstream: "openrouter", messageId: `gen-${seq}` });

/**
 * What a completed call cost.
 * @param seq - The call.
 * @returns Its cost.
 */
const known = (seq: number): Cost => ({ state: "known", usd: 0.0001 * seq, source: "reported" });

/**
 * A call's end with counters and cost.
 * @param seq - The call.
 * @param outcome - How it ended.
 * @returns The event.
 */
const ended = (
  seq: number,
  outcome: "completed" | "upstream_error" | "interrupted" = "completed",
): WebAnimationJobEvent => ({
  type: "endModelCall",
  seq,
  outcome,
  upstream: outcome === "upstream_error" ? null : "openrouter",
  tokens: outcome === "upstream_error" ? null : TOKENS,
  cost: outcome === "completed" ? known(seq) : null,
});

const writtenPackage: WebAnimationJobEvent = { type: "written", key: REQUEST.packageKey, sha256: SHA, bytes: 4_000 };
const writtenManifest: WebAnimationJobEvent = { type: "written", key: REQUEST.manifestKey, sha256: "b".repeat(64), bytes: 300 };

describe("submit", () => {
  it("starts a fresh job running and asks the object to start the container", () => {
    const [result] = run(null, [{ type: "submit", request: REQUEST }]);

    expect(result!.effects).toContain("start");
    expect(result!.refused).toBe(false);
    expect(report(result!.record)).toEqual({
      state: "running", phase: null, steps: [], calls: [], container: null, outputs: [], failureReason: null,
    });
  });

  it("answers a second submit of the same job with the job it holds and starts nothing", () => {
    const held = after([begin, started(1), ended(1)]);
    const [result] = run(held, [{ type: "submit", request: REQUEST }]);

    expect(result!.effects).toEqual([]);
    expect(result!.refused).toBe(false);
    expect(result!.record).toEqual(held);
  });

  it("ends a submit that arrives at or after its deadline as expired without starting a container", () => {
    const late = transitionWebAnimationJob(null, { type: "submit", request: REQUEST }, REQUEST.deadlineAt);

    expect(late.effects).not.toContain("start");
    expect(report(late.record).state).toBe("expired");
  });

  it("forgets a job whose container could not start, so the next submit starts it again", () => {
    const [, failed] = run(null, [{ type: "submit", request: REQUEST }, { type: "startFailed" }]);

    expect(failed!.record).toBeNull();
    expect(reportOfWebAnimationJob(failed!.record)).toBeNull();
    const [again] = run(failed!.record, [{ type: "submit", request: REQUEST }]);
    expect(again!.effects).toContain("start");
  });
});

describe("cancel before any submit", () => {
  it("keeps a marker that answers cancelled_before_submit", () => {
    const [result] = run(null, [{ type: "cancel", deadlineAt: REQUEST.deadlineAt }]);

    expect(result!.effects).toEqual([]);
    expect(report(result!.record)).toEqual({
      state: "cancelled_before_submit", phase: null, steps: [], calls: [], container: null, outputs: [], failureReason: null,
    });
  });

  it("refuses a submit while the marker stands, starting nothing and keeping the marker", () => {
    const [marked, submitted] = run(null, [{ type: "cancel", deadlineAt: REQUEST.deadlineAt }, { type: "submit", request: REQUEST }]);

    expect(submitted!.refused).toBe(true);
    expect(submitted!.effects).toEqual([]);
    expect(submitted!.record).toEqual(marked!.record);
  });

  it("answers a repeated cancel with the same marker", () => {
    const [first, second] = run(null, [
      { type: "cancel", deadlineAt: REQUEST.deadlineAt },
      { type: "cancel", deadlineAt: REQUEST.deadlineAt },
    ]);

    expect(report(second!.record)).toEqual(report(first!.record));
  });
});

describe("beginModelCall", () => {
  it("numbers calls from 1 and gives the next one seq+1 once the first has ended", () => {
    const results = run(null, [{ type: "submit", request: REQUEST }, begin, started(1), ended(1), begin]);

    expect(results[1]!.seq).toBe(1);
    expect(results[4]!.seq).toBe(2);
  });

  it("refuses a second call while one is in flight, whether or not it has started streaming", () => {
    const [, first, second, , third] = run(null, [{ type: "submit", request: REQUEST }, begin, begin, started(1), begin]);

    expect(first!.seq).toBe(1);
    expect(second!.seq).toBeNull();
    expect(third!.seq).toBeNull();
    expect(report(third!.record).calls).toEqual([]);
  });

  it("gives a retry after an upstream error a new seq and keeps the failed call on record", () => {
    const record = after([begin, ended(1, "upstream_error"), begin, started(2), ended(2)]);

    expect(report(record).calls).toEqual([
      { seq: 1, upstream: null, messageId: null, tokens: null, cost: null, outcome: "upstream_error" },
      { seq: 2, upstream: "openrouter", messageId: "gen-2", tokens: TOKENS, cost: known(2), outcome: "completed" },
    ]);
  });

  it("refuses a call once the job is stopping", () => {
    const [, , , , refused] = run(null, [{ type: "submit", request: REQUEST }, begin, started(1), { type: "cancel", deadlineAt: REQUEST.deadlineAt }, begin]);

    expect(refused!.seq).toBeNull();
    expect(report(refused!.record).state).toBe("stopping");
  });

  it("refuses a call once the job has ended", () => {
    const done = after([writtenPackage, writtenManifest, { type: "finished", ok: true, failureReason: null, cpuUsec: 10 }]);
    const [refused] = run(done, [begin]);

    expect(refused!.seq).toBeNull();
    expect(refused!.record).toEqual(done);
  });
});

describe("recordModelCallStart and endModelCall", () => {
  it("record the upstream, message id, counters, cost and outcome by seq", () => {
    const record = after([begin, started(1), ended(1)]);

    expect(report(record).calls).toEqual([
      { seq: 1, upstream: "openrouter", messageId: "gen-1", tokens: TOKENS, cost: known(1), outcome: "completed" },
    ]);
  });

  it("ignore a seq the job never began", () => {
    const record = after([begin, started(1)]);
    const [late] = run(record, [started(5), ended(5)]);

    expect(late!.record).toEqual(record);
  });

  it("list only ended calls in a running job's report", () => {
    const record = after([begin, started(1), ended(1), begin, started(2)]);

    expect(report(record).calls.map((call) => call.seq)).toEqual([1]);
  });
});

describe("draining on cancel", () => {
  it("stops at once and ends cancelled when no call is in flight", () => {
    const record = after([begin, started(1), ended(1)]);
    const [cancelled] = run(record, [{ type: "cancel", deadlineAt: REQUEST.deadlineAt }]);

    expect(cancelled!.effects).toContain("destroy");
    expect(report(cancelled!.record).state).toBe("cancelled");
  });

  it("waits for the call in flight, then stops and ends cancelled in the same transition that ends that call", () => {
    const record = after([begin, started(1)]);
    const [stopping, drained] = run(record, [{ type: "cancel", deadlineAt: REQUEST.deadlineAt }, ended(1)]);

    expect(stopping!.effects).not.toContain("destroy");
    expect(report(stopping!.record).state).toBe("stopping");
    expect(drained!.effects).toContain("destroy");
    const final = report(drained!.record);
    expect(final.state).toBe("cancelled");
    expect(final.calls).toEqual([{ seq: 1, upstream: "openrouter", messageId: "gen-1", tokens: TOKENS, cost: known(1), outcome: "completed" }]);
    expect(final.container).not.toBeNull();
  });

  it("drains a call that has begun but not yet started streaming", () => {
    const record = after([begin]);
    const [stopping, drained] = run(record, [{ type: "cancel", deadlineAt: REQUEST.deadlineAt }, ended(1, "upstream_error")]);

    expect(report(stopping!.record).state).toBe("stopping");
    expect(report(drained!.record).state).toBe("cancelled");
  });

  it("answers a repeated cancel while stopping without stopping twice", () => {
    const record = after([begin, started(1), { type: "cancel", deadlineAt: REQUEST.deadlineAt }]);
    const [again] = run(record, [{ type: "cancel", deadlineAt: REQUEST.deadlineAt }]);

    expect(again!.effects).not.toContain("destroy");
    expect(report(again!.record).state).toBe("stopping");
  });
});

describe("draining at the deadline", () => {
  it("stops at once and ends expired when no call is in flight", () => {
    const [expired] = run(after([]), [{ type: "deadline" }]);

    expect(expired!.effects).toContain("destroy");
    expect(report(expired!.record).state).toBe("expired");
  });

  it("waits for the call in flight, then stops and ends expired", () => {
    const [stopping, drained] = run(after([begin, started(1)]), [{ type: "deadline" }, ended(1)]);

    expect(stopping!.effects).not.toContain("destroy");
    expect(report(stopping!.record).state).toBe("stopping");
    expect(drained!.effects).toContain("destroy");
    expect(report(drained!.record).state).toBe("expired");
    expect(report(drained!.record).calls[0]!.cost).toEqual(known(1));
  });
});

describe("the end of a job", () => {
  it("ends done once the container reports success and both outputs are written", () => {
    const done = run(null, [
      { type: "submit", request: REQUEST },
      { type: "progress", phase: "writing", steps: [{ tool: "write", path: "index.html" }] },
      begin, started(1), ended(1),
      { type: "progress", phase: "saving", steps: [{ tool: "write", path: "index.html" }, { check: "fonts", ok: true }] },
      writtenPackage, writtenManifest,
      { type: "finished", ok: true, failureReason: null, cpuUsec: 1_234 },
    ]).at(-1);

    expect(done!.effects).toContain("destroy");
    const final = report(done!.record);
    expect(final.state).toBe("done");
    expect(final.phase).toBe("saving");
    expect(final.steps).toEqual([{ tool: "write", path: "index.html" }, { check: "fonts", ok: true }]);
    expect(final.outputs).toEqual([
      { key: REQUEST.packageKey, sha256: SHA, bytes: 4_000 },
      { key: REQUEST.manifestKey, sha256: "b".repeat(64), bytes: 300 },
    ]);
    expect(final.container?.cpuUsec).toBe(1_234);
    expect(final.container?.wallMs).toBeGreaterThan(0);
    expect(final.failureReason).toBeNull();
  });

  it("fails a success report that arrives before both outputs are written", () => {
    const [failed] = run(after([writtenPackage]), [{ type: "finished", ok: true, failureReason: null, cpuUsec: null }]);

    const final = report(failed!.record);
    expect(final.state).toBe("failed");
    expect(final.failureReason).not.toBeNull();
  });

  it("keeps the reason a failure report names", () => {
    const [failed] = run(after([]), [{ type: "finished", ok: false, failureReason: "font_not_in_set", cpuUsec: 9 }]);

    expect(report(failed!.record)).toMatchObject({ state: "failed", failureReason: "font_not_in_set" });
  });

  it("ignores a write to a key the job does not name", () => {
    const record = after([]);
    const [ignored] = run(record, [{ type: "written", key: "web-animation/other/index.html", sha256: SHA, bytes: 1 }]);

    expect(report(ignored!.record).outputs).toEqual([]);
  });

  it("marks an open call cut_off and fails the job when the container is gone while running", () => {
    const [gone] = run(after([begin, started(1), ended(1), begin, started(2)]), [{ type: "containerGone" }]);

    const final = report(gone!.record);
    expect(final.state).toBe("failed");
    expect(final.calls).toEqual([
      { seq: 1, upstream: "openrouter", messageId: "gen-1", tokens: TOKENS, cost: known(1), outcome: "completed" },
      { seq: 2, upstream: "openrouter", messageId: "gen-2", tokens: null, cost: null, outcome: "cut_off" },
    ]);
  });

  it("ends a stopping job as it was stopping, marking the open call cut_off, when the container is gone", () => {
    const record = after([begin, started(1), { type: "cancel", deadlineAt: REQUEST.deadlineAt }]);
    const [gone] = run(record, [{ type: "containerGone" }]);

    const final = report(gone!.record);
    expect(final.state).toBe("cancelled");
    expect(final.calls.map((call) => call.outcome)).toEqual(["cut_off"]);
  });
});

describe("after the end", () => {
  const ends: Array<[string, WebAnimationJobEvent[]]> = [
    ["done", [writtenPackage, writtenManifest, { type: "finished", ok: true, failureReason: null, cpuUsec: 5 }]],
    ["failed", [{ type: "finished", ok: false, failureReason: "validation_failed", cpuUsec: 5 }]],
    ["cancelled", [{ type: "cancel", deadlineAt: REQUEST.deadlineAt }]],
    ["expired", [{ type: "deadline" }]],
  ];

  it.each(ends)("ignores every later write to a job that ended %s, so each read returns the same report", (_state, endEvents) => {
    const record = after([begin, started(1), ended(1), ...endEvents]);
    const before = report(record);
    const later = run(record, [
      begin, started(2), ended(2), started(1), ended(1, "interrupted"),
      { type: "cancel", deadlineAt: REQUEST.deadlineAt }, { type: "deadline" }, { type: "containerGone" },
      writtenPackage, { type: "progress", phase: "validating", steps: ["late"] },
      { type: "finished", ok: true, failureReason: null, cpuUsec: 99 },
      { type: "submit", request: REQUEST },
    ]);

    for (const result of later) {
      expect(result.effects).toEqual([]);
      expect(report(result.record)).toEqual(before);
    }
  });
});

describe("invariants over any sequence of events", () => {
  const eventArb: fc.Arbitrary<WebAnimationJobEvent> = fc.oneof(
    fc.constant(begin),
    fc.integer({ min: 1, max: 6 }).map(started),
    fc.tuple(fc.integer({ min: 1, max: 6 }), fc.constantFrom("completed", "upstream_error", "interrupted"))
      .map(([seq, outcome]) => ended(seq, outcome)),
    fc.constant<WebAnimationJobEvent>({ type: "cancel", deadlineAt: REQUEST.deadlineAt }),
    fc.constant<WebAnimationJobEvent>({ type: "deadline" }),
    fc.constant<WebAnimationJobEvent>({ type: "containerGone" }),
    fc.constant(writtenPackage),
    fc.constant(writtenManifest),
    fc.boolean().map((ok): WebAnimationJobEvent => ({ type: "finished", ok, failureReason: ok ? null : "tool_failed", cpuUsec: 1 })),
  );

  it("keeps at most one call in flight, numbers calls 1, 2, 3 in order and stops the container at most once", () => {
    fc.assert(fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
      const results = run(null, [{ type: "submit", request: REQUEST }, ...events]);
      let inFlight: number | null = null;
      let lastSeq = 0;
      let stops = 0;
      results.forEach((result, i) => {
        const event = i === 0 ? null : events[i - 1]!;
        if (event?.type === "beginModelCall" && result.seq !== null) {
          expect(inFlight).toBeNull();
          expect(result.seq).toBe(lastSeq + 1);
          lastSeq = result.seq;
          inFlight = result.seq;
        }
        if ((event?.type === "endModelCall" && event.seq === inFlight) || event?.type === "containerGone") inFlight = null;
        if (result.effects.includes("destroy")) stops += 1;
      });
      expect(stops).toBeLessThanOrEqual(1);
    }), { numRuns: 300 });
  });

  it("never changes a terminal report, and a terminal report has every call ended", () => {
    const terminal = new Set(["done", "failed", "cancelled", "expired"]);
    fc.assert(fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
      const results = run(null, [{ type: "submit", request: REQUEST }, ...events]);
      let frozen: WebAnimationJobReport | null = null;
      for (const result of results) {
        const current = report(result.record);
        if (frozen !== null) expect(current).toEqual(frozen);
        else if (terminal.has(current.state)) {
          frozen = current;
          const seqs = current.calls.map((call) => call.seq);
          expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        }
      }
    }), { numRuns: 300 });
  });
});
