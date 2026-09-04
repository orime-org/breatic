// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Arming a timer whose deadline has already gone by (#186 §4.6.5).
 *
 * The server takes time to reach the arm call and a budget can be short, so a
 * deadline in the past is a deadline: it is accepted, and the runtime runs
 * the alarm straight away.
 *
 * That last part is why this case is alone in a file. An alarm already due
 * fires on the runtime's schedule, not on the case's: it can land before the
 * case looks, after the case has ended, or during a later one, whose
 * assertions it then breaks (#193). Nothing here can make it deterministic,
 * so what it disturbs is kept down to itself — one case, its own module
 * state, and an interceptor that answers the knock whenever it arrives.
 */

import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

const SERVER_ORIGIN = "https://api.past.example";
const EXPIRE_PATH = "/api/v1/canvas/node-tasks/expired";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe("arming a deadline that has already passed", () => {
  it("is accepted", async () => {
    const taskId = crypto.randomUUID();
    const stub = env.TASK_TIMER.get(env.TASK_TIMER.idFromName(taskId));

    // Persistent, and never asserted on: the knock is coming, and when is not
    // this case's to say.
    fetchMock
      .get(SERVER_ORIGIN)
      .intercept({ path: EXPIRE_PATH, method: "POST" })
      .reply(200, "")
      .persist();

    const armed = await stub.fetch("https://timer.invalid/arm", {
      method: "POST",
      body: JSON.stringify({
        taskId,
        deadlineAt: Date.now() - 1_000,
        callbackUrl: `${SERVER_ORIGIN}${EXPIRE_PATH}`,
      }),
    });

    expect(armed.status).toBe(204);
  });
});
