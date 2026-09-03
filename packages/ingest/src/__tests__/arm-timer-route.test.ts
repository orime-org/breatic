// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The Worker route that arms a task timer (#186, design §4.6.5).
 *
 * Our server is the only caller. It reaches the timer through here because a
 * Durable Object has no address of its own outside the Worker that binds it,
 * and it proves who it is with the same shared secret the ingest report
 * carries back the other way.
 *
 * The browser never touches this route. It is not part of the CORS surface
 * and it is not signed with a ticket: a ticket says "this upload may send
 * bytes", and nothing a browser holds should be able to say when a task
 * stops counting as alive.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "@ingest/index.js";

const SECRET = "test-ingest-secret";

let seq = 0;

/**
 * Ask the Worker to arm a timer.
 * @param body - What to send.
 * @param secret - The shared secret header, omitted when null.
 * @returns The Worker's response.
 */
async function arm(
  body: Record<string, unknown>,
  secret: string | null = SECRET,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-ingest-secret"] = secret;

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://ingest.test.example/task-timers/arm", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** A well-formed arm request nobody else has used. */
function request(): Record<string, unknown> {
  return {
    taskId: `route-task-${++seq}`,
    deadlineAt: Date.now() + 60_000,
    callbackUrl: "https://api.test.example/api/v1/canvas/node-tasks/expired",
  };
}

describe("POST /task-timers/arm", () => {
  it("arms the timer for the task it names", async () => {
    const body = request();
    expect((await arm(body)).status).toBe(204);

    const stub = env.TASK_TIMER.get(
      env.TASK_TIMER.idFromName(body["taskId"] as string),
    );
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_i: unknown, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("refuses a caller without the shared secret", async () => {
    expect((await arm(request(), null)).status).toBe(401);
  });

  it("refuses a caller whose secret is wrong", async () => {
    expect((await arm(request(), "not-the-secret")).status).toBe(401);
  });

  it("arms nothing when the secret is wrong", async () => {
    const body = request();
    await arm(body, "not-the-secret");

    const stub = env.TASK_TIMER.get(
      env.TASK_TIMER.idFromName(body["taskId"] as string),
    );
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_i: unknown, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("passes a malformed body's refusal back", async () => {
    const res = await arm({ taskId: "only-this" });
    expect(res.status).toBe(400);
  });
});
