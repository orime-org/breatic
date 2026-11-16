// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `model.local` outbound relay of the web-animation container (inner#1711 design §6, DD §3.1; inner#1743).
 *
 * Every process in the container can reach `model.local`, so this relay, not the harness, decides what reaches a
 * model: only `POST /v1/messages` with a JSON body, handed to provider's Messages relay along the job's plan, which
 * rebuilds the body from the Messages field allowlist, clamps `max_tokens`, sends the plan's model, picks the upstream
 * and reads what the call cost.
 *
 * Each call is registered with the job's Durable Object before it is sent and ended exactly once, whatever happens
 * to it; the object refuses a new call while one is open or once the job is stopping. A plain function so it runs on
 * Node in tests; the container class wires it to its outbound handler.
 */

import { relayMessages, type MessagesCallEnd, type MessagesPlan } from "@breatic/provider/messages";

/** The fake host the container's harness sends model calls to. */
export const MODEL_HOST = "model.local";

/** What the relay needs: the job's plan and limits, the Worker's keys and the job object's registry. */
export interface ModelRelayDeps {
  plan: MessagesPlan;
  /** Reads the Worker's copy of one key the plan names. */
  keyOf: (envName: string) => string | undefined;
  maxTokens: number;
  callTimeoutMs: number;
  registry: {
    /** A seq for the new call, or null when the job refuses one. */
    beginModelCall: () => Promise<number | null>;
    recordModelCallStart: (seq: number, upstream: string, messageId: string) => Promise<void>;
    endModelCall: (seq: number, end: MessagesCallEnd) => Promise<void>;
  };
}

/**
 * Whether a value is a JSON object.
 * @param value - The value.
 * @returns True for a non-null, non-array object.
 * @throws {never} Never.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Relay one model call from the container along the job's plan.
 * @param request - What the harness sent to `model.local`.
 * @param deps - The job's plan and limits, the keys and the registry.
 * @returns The upstream answer, streamed; 403 for anything but `POST /v1/messages`, 400 for a body that is not a JSON
 *   object, 409 when the job refuses a call, a refusal as the upstream gave it, 502 when no upstream could be reached.
 * @throws {unknown} What the registry throws when the job object cannot be reached.
 */
export async function relayModelCall(request: Request, deps: ModelRelayDeps): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") {
    return new Response("Not allowed", { status: 403 });
  }
  let asked: unknown;
  try {
    asked = JSON.parse(await request.text());
  } catch {
    return new Response("Not a Messages body", { status: 400 });
  }
  if (!isObject(asked)) return new Response("Not a Messages body", { status: 400 });

  const seq = await deps.registry.beginModelCall();
  if (seq === null) return new Response("The job takes no model call now", { status: 409 });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.callTimeoutMs);
  const abandon = (): void => abort.abort();
  request.signal.addEventListener("abort", abandon);
  const version = request.headers.get("anthropic-version");
  return relayMessages(deps.plan, asked, {
    keyOf: deps.keyOf,
    maxTokens: deps.maxTokens,
    signal: abort.signal,
    ...(version === null ? {} : { anthropicVersion: version }),
    onStarted: (upstream, messageId) => deps.registry.recordModelCallStart(seq, upstream, messageId),
    onEnded: async (end) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abandon);
      await deps.registry.endModelCall(seq, end);
    },
  });
}
