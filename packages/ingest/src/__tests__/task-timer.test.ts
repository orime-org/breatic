// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The timer that judges a task dead (#186, design §4.6).
 *
 * It holds three things — a task id, when its time is up, where to knock —
 * and does one: at the deadline it POSTs to the server. It never learns
 * whether the task is an upload or a generation, who started it, or how far
 * it got. The server queries the row and decides; a terminal row is a no-op.
 *
 * There is no cancel. A task that finishes early still gets its knock, and
 * the server does nothing with it. Cancelling would mean changing this
 * object's state between birth and firing, and having no state to change is
 * the whole of what it is for.
 *
 * The one hard requirement: a delivery that fails schedules the next alarm
 * itself. Cloudflare retries an alarm handler six times over roughly two
 * minutes and then stops, and this is the only thing that notices a task
 * whose time ran out.
 */

import {
  env,
  fetchMock,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { taskExpiryKnock } from "@breatic/shared";
import type { TaskTimer } from "@ingest/task-timer.js";

const SERVER_ORIGIN = "https://api.test.example";

/**
 * Far enough ahead that the runtime will not run the alarm on its own, so
 * every firing below is one this test drove.
 */
const FAR = 60_000;
const EXPIRE_PATH = "/api/v1/canvas/node-tasks/expired";

let seq = 0;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  knocks.length = 0;
  knockHeaders.length = 0;
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

/** Every body the timer sent, in order. */
const knocks: Record<string, unknown>[] = [];

/** The headers each of those knocks carried. */
const knockHeaders: Record<string, string>[] = [];

/**
 * Let the server answer the next `times` knocks with `status`.
 * @param status - What the server answers.
 * @param times - How many knocks this interceptor covers.
 */
function serverAnswers(status: number, times = 1): void {
  fetchMock
    .get(SERVER_ORIGIN)
    .intercept({ path: EXPIRE_PATH, method: "POST" })
    .reply(status, (opts: { body?: string; headers?: Record<string, string> }) => {
      knocks.push(JSON.parse(opts.body ?? "{}") as Record<string, unknown>);
      knockHeaders.push(opts.headers ?? {});
      return "";
    })
    .times(times);
}

/** A fresh timer instance nobody else has touched. */
function timerFor(taskId: string): DurableObjectStub {
  return env.TASK_TIMER.get(env.TASK_TIMER.idFromName(taskId));
}

/**
 * Arm a timer and hand back its stub and task id.
 * @param deadlineInMs - How far ahead the deadline sits.
 * @returns The stub and the task id it was armed with.
 */
async function armed(
  deadlineInMs: number,
): Promise<{ stub: DurableObjectStub; taskId: string }> {
  const taskId = `task-${++seq}`;
  const stub = timerFor(taskId);
  const res = await stub.fetch("https://timer.invalid/arm", {
    method: "POST",
    body: JSON.stringify({
      taskId,
      deadlineAt: Date.now() + deadlineInMs,
      callbackUrl: `${SERVER_ORIGIN}${EXPIRE_PATH}`,
    }),
  });
  expect(res.status).toBe(204);
  return { stub, taskId };
}

describe("arming a timer", () => {
  it("sets one alarm at the deadline it was given", async () => {
    const { stub } = await armed(FAR);

    await runInDurableObject(stub, async (_instance: TaskTimer, state) => {
      const at = await state.storage.getAlarm();
      expect(at).not.toBeNull();
      expect(at! - Date.now()).toBeGreaterThan(FAR / 2);
    });
  });

  it("refuses a body without the three things it needs", async () => {
    const stub = timerFor(`task-${++seq}`);
    const res = await stub.fetch("https://timer.invalid/arm", {
      method: "POST",
      body: JSON.stringify({ taskId: "t" }),
    });
    expect(res.status).toBe(400);
  });

});

describe("the deadline arrives", () => {
  it("knocks once, naming only the task", async () => {
    serverAnswers(200);
    const { stub, taskId } = await armed(FAR);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(knocks).toEqual([taskExpiryKnock(taskId)]);
    // The endpoint it knocks on is reachable from the internet and takes a
    // task id as its whole argument, so it has to know the caller is us.
    expect(knockHeaders[0]?.["x-ingest-secret"]).toBe(
      env.INGEST_SHARED_SECRET,
    );
  });

  it("schedules no further alarm once the server took it", async () => {
    serverAnswers(200);
    const { stub } = await armed(FAR);
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance: TaskTimer, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("keeps its own retry going when the server refuses", async () => {
    // Cloudflare gives an alarm handler six retries over about two minutes
    // and then stops. This object is the only thing that notices a task
    // whose time ran out, so it schedules the next attempt itself and the
    // handler returns normally.
    serverAnswers(503);
    const { stub } = await armed(FAR);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance: TaskTimer, state) => {
      const at = await state.storage.getAlarm();
      expect(at).not.toBeNull();
      expect(at!).toBeGreaterThan(Date.now());
    });
  });

  it("keeps its own retry going when the request never lands", async () => {
    fetchMock
      .get(SERVER_ORIGIN)
      .intercept({ path: EXPIRE_PATH, method: "POST" })
      .replyWithError(new Error("connection refused"));

    const { stub } = await armed(FAR);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance: TaskTimer, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("stops retrying once a later attempt gets through", async () => {
    serverAnswers(503);
    const { stub, taskId } = await armed(FAR);
    await runDurableObjectAlarm(stub);

    serverAnswers(200);
    await runDurableObjectAlarm(stub);

    expect(knocks).toEqual([taskExpiryKnock(taskId), taskExpiryKnock(taskId)]);
    await runInDurableObject(stub, async (_instance: TaskTimer, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("knocks for a task that already finished, and says nothing about it", async () => {
    // No cancel: an early finish still gets its knock. What makes that
    // harmless is that the server answers 200 to a terminal row, which
    // reads here exactly like a row it just expired.
    serverAnswers(200);
    const { stub, taskId } = await armed(FAR);

    await runDurableObjectAlarm(stub);

    expect(knocks).toEqual([taskExpiryKnock(taskId)]);
  });

  it("does nothing when the alarm fires before anything armed it", async () => {
    const stub = timerFor(`task-${++seq}`);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(knocks).toEqual([]);
  });
});
