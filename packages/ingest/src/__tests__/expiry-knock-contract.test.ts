// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body the timer knocks with is the body our server reads (#186 §4.6).
 *
 * The two runtimes on either side of this knock are tested apart — the timer
 * inside workerd against a stubbed server, the route in Node against a
 * hand-written body — so each suite could be green on a field name the other
 * one never used, and was. This case puts the body one of them writes in
 * front of the parser the other one mounts.
 *
 * A knock the route cannot read has no symptom either side can see: the route
 * answers 422, `response.ok` is false, the alarm reads that as the server
 * being unwell and re-arms thirty seconds out, and no task is ever judged
 * dead by anyone.
 *
 * It lives in its own file so the suite next door keeps the case order it
 * was written with; that one has a case whose alarm the runtime fires on its
 * own schedule (#193), and inserting anything among them moves where its
 * knock lands.
 */

import { env, fetchMock, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readTaskExpiryKnock } from "@breatic/shared";

const SERVER_ORIGIN = "https://api.contract.example";
const EXPIRE_PATH = "/api/v1/canvas/node-tasks/expired";

/** Far enough ahead that the alarm below is one this case drove. */
const FAR = 60_000;

/** Every body the timer sent. */
const knocks: unknown[] = [];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  knocks.length = 0;
  fetchMock.assertNoPendingInterceptors();
});

describe("the knock a timer sends", () => {
  it("carries a task id the server's parser can read back", async () => {
    const taskId = crypto.randomUUID();
    const stub = env.TASK_TIMER.get(env.TASK_TIMER.idFromName(taskId));

    fetchMock
      .get(SERVER_ORIGIN)
      .intercept({ path: EXPIRE_PATH, method: "POST" })
      .reply(200, (opts: { body?: string }) => {
        knocks.push(JSON.parse(opts.body ?? "{}"));
        return "";
      });

    const armed = await stub.fetch("https://timer.invalid/arm", {
      method: "POST",
      body: JSON.stringify({
        taskId,
        deadlineAt: Date.now() + FAR,
        callbackUrl: `${SERVER_ORIGIN}${EXPIRE_PATH}`,
      }),
    });
    expect(armed.status).toBe(204);

    await runDurableObjectAlarm(stub);

    // Asserting on the parsed value rather than the raw JSON is the point: a
    // rename on either side has to move both, or this goes red.
    expect(knocks).toHaveLength(1);
    expect(readTaskExpiryKnock(knocks[0])).toBe(taskId);
  });
});
