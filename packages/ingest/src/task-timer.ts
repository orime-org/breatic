// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One task's deadline (#186, design §4.6).
 *
 * The instance is addressed by task id and holds three things: that id, when
 * the time is up, and where to knock. At the deadline it POSTs the id to the
 * server, which queries the row and decides — a row still running becomes
 * expired, a row already terminal is a no-op. Nothing here knows whether the
 * task is an upload or a generation, who started it, or how far it got.
 *
 * There is no cancel. A task that finishes early still gets its knock, and
 * the server does nothing with it. Cancelling would mean writing to this
 * object between birth and firing, and having nothing to write is the whole
 * of what it is for: no cancel, so no "the cancel failed" to handle.
 *
 * The knock is not idempotent on this side and does not need to be — the
 * server's answer to a terminal row and to a row it just expired are the
 * same, so a duplicate costs one request.
 */

/** How long to wait before knocking again after a delivery that failed. */
const RETRY_DELAY_MS = 30_000;

/** What arming a timer says. */
interface ArmRequest {
  taskId: string;
  /** Epoch milliseconds. */
  deadlineAt: number;
  callbackUrl: string;
}

/** What this object remembers between being armed and firing. */
type ArmedState = ArmRequest;

/**
 * Read an arm request out of a body, or say it is not one.
 * @param body - The parsed request body.
 * @returns The request, or null when a field is missing or the wrong type.
 */
function readArmRequest(body: unknown): ArmRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { taskId, deadlineAt, callbackUrl } = body as Record<string, unknown>;
  if (typeof taskId !== "string" || taskId === "") return null;
  if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
    return null;
  }
  if (typeof callbackUrl !== "string" || callbackUrl === "") return null;
  return { taskId, deadlineAt, callbackUrl };
}

/** A task's deadline, kept by Cloudflare and delivered once it passes. */
export class TaskTimer implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: { INGEST_SHARED_SECRET: string };

  /**
   * @param state - This instance's storage and alarm.
   * @param env - The Worker's bindings, of which this needs the secret that
   *   proves to the server the knock came from us.
   */
  constructor(
    state: DurableObjectState,
    env: { INGEST_SHARED_SECRET: string },
  ) {
    this.#state = state;
    this.#env = env;
  }

  /**
   * Arm this timer. The only request it answers.
   * @param request - Carries the task id, the deadline and the callback.
   * @returns 204 once the alarm is set, 400 for a body missing a field.
   */
  async fetch(request: Request): Promise<Response> {
    const armed = readArmRequest(await request.json().catch(() => null));
    if (armed === null) {
      return new Response("Expected taskId, deadlineAt and callbackUrl", {
        status: 400,
      });
    }

    await this.#state.storage.put("armed", armed);
    // A deadline already in the past is a deadline: the server takes time to
    // get here and a budget can be short. Cloudflare runs an alarm set in the
    // past at the next opportunity.
    await this.#state.storage.setAlarm(armed.deadlineAt);
    return new Response(null, { status: 204 });
  }

  /**
   * The deadline arrived: tell the server, once.
   *
   * A delivery that fails schedules the next attempt here rather than letting
   * the handler throw. Cloudflare retries a failing alarm six times over
   * roughly two minutes and then stops for good, and this object is the only
   * thing that notices a task whose time ran out — so the retry has to be
   * ours and has to be unbounded.
   * @returns Nothing. Failure leaves a new alarm behind, not an exception.
   */
  async alarm(): Promise<void> {
    const armed = await this.#state.storage.get<ArmedState>("armed");
    // The alarm fired without anything having armed it. Nothing to say and
    // nobody to say it to.
    if (armed === undefined) return;

    let delivered = false;
    try {
      const response = await fetch(armed.callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ingest-secret": this.#env.INGEST_SHARED_SECRET,
        },
        body: JSON.stringify({ taskId: armed.taskId }),
      });
      delivered = response.ok;
    } catch {
      delivered = false;
    }

    if (delivered) {
      await this.#state.storage.delete("armed");
      return;
    }

    console.error("task_timer_delivery_failed", {
      taskId: armed.taskId,
      retryInMs: RETRY_DELAY_MS,
    });
    await this.#state.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
  }
}
