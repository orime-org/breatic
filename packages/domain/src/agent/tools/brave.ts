// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One request to Brave, from the address to the parsed answer.
 *
 * Two tools reach two endpoints of the same service, and everything between
 * the address and the JSON is the same for both: the header the service names,
 * the redirect it must not follow, the budget each delivery gets, and the three
 * ways the round trip ends badly. Written once here, so that the security
 * invariant among them -- a subscription token must not travel to a host a
 * redirect names -- is stated in one place rather than copied per endpoint.
 */
import { FAILURE_LINES, httpRequest, reasonOf, readWithin } from "@breatic/shared";

import {
  isStop,
  notOurPayloadReason,
  readFailedReason,
  refusalReason,
  stoppedByUser,
  toolFailed,
} from "@domain/agent/tools/failure.js";
import type { FailureVoice } from "@domain/agent/tools/failure.js";

/** What one call to Brave needs to know. */
export interface BraveRequest {
  /** The endpoint, with its query already on it. */
  url: URL;
  /** The subscription token. */
  apiKey: string;
  /** How the calling tool names what it does, for the sentences it may fail with. */
  voice: FailureVoice;
  /** What was searched for, as it should read in those sentences. */
  query: string;
  /** How long ONE LEG may take. */
  budgetMs: number;
  /** The turn's signal, when the tool was given one. */
  abortSignal?: AbortSignal;
}

/**
 * Ask Brave, and hand back whatever JSON it answered with.
 *
 * Reading and parsing are guarded apart because they are two different facts
 * about the same answer. A read that threw means this side never saw what the
 * service meant to send, so asking again may well get it; a body that arrived
 * whole and is not JSON is the service answering something else, and a second
 * delivery returns the same bytes.
 *
 * What the answer means is the caller's business -- this gets as far as
 * "the service replied, and it replied with JSON".
 * @param request - Where to ask and how to talk about it.
 * @returns The parsed body.
 * @throws {Error} Carrying tool failure detail, or the user's stop.
 */
export async function braveJson(request: BraveRequest): Promise<unknown> {
  const { url, apiKey, voice, query, budgetMs, abortSignal } = request;

  // Through the shared transport, which owns the retrying. Either search is a
  // read: its only effect is the response, so a delivery that produced none
  // produced no effect to repeat -- which is what `replaySafe` states.
  //
  // The budget goes in as `timeoutMs` rather than as a signal on the init: the
  // transport replaces the caller's signal, so one left there would be a no-op
  // and the call would silently get the transport's default instead. That
  // figure bounds ONE DELIVERY -- the transport may deliver this request more
  // than once and gives each of them the full budget.
  //
  // `redirect: "manual"` is not a detail of either endpoint. The Fetch
  // specification strips only Authorization, Cookie and Proxy-Authorization
  // across origins, so a custom header travels: following a 301 would carry
  // the subscription token to whatever host the redirect names. We never
  // intend to leave this host, so a 3xx is a refusal.
  const res = await httpRequest(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      redirect: "manual",
    },
    {
      replaySafe: true,
      timeoutMs: budgetMs,
      ...(abortSignal ? { signal: abortSignal } : {}),
    },
  );

  if (!res.ok) {
    // A body nobody reads keeps its connection out of the pool: the transport
    // measured reuse collapsing past undici's buffering threshold, and says a
    // caller discarding one should cancel it. A run of refusals -- a revoked
    // key, a rate limit -- is a run of these.
    //
    // Discarding the promise is safe only while nothing awaits between the
    // transport handing this response back and this line: cancelling a body
    // that has already errored rejects, and neither server nor worker installs
    // an `unhandledRejection` handler.
    void res.body?.cancel();
    throw toolFailed(refusalReason(voice, query, res.status), FAILURE_LINES.upstream);
  }

  let text: string;
  try {
    text = await readWithin(res, budgetMs, abortSignal);
  } catch (err: unknown) {
    // Asked here rather than left to the caller's guard, which never sees
    // this: that guard passes anything carrying failure detail straight
    // through, past the question of whether the user stopped.
    if (isStop(err, abortSignal)) throw stoppedByUser();
    throw toolFailed(readFailedReason(voice, query, reasonOf(err)), FAILURE_LINES.upstream);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw toolFailed(notOurPayloadReason(voice, query), FAILURE_LINES.upstream);
  }
}
