// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The decisions endpoint, as one request and one reading of its answer.
 *
 * Built the way `understand.ts:271-291` builds its own vendor call -- the
 * body read here, the caller's stop passed through -- because that one sits
 * on the same vendor and the same key.
 *
 * Every answer key carries its own `type`, so every key is checked alone.
 * One key the endpoint phrased in a shape we cannot read says nothing about
 * the keys beside it, and the model asking three questions at once is what
 * this endpoint is for.
 */

import { FAILURE_LINES, httpRequest, readWithin, reasonOf } from "@breatic/shared";
import { z } from "zod";

import type { FailureVoice } from "@domain/agent/tools/failure.js";
import {
  clip,
  isStop,
  keepInside,
  nextMovesFor,
  onOneLine,
  reason,
  refusalReason,
  stoppedByUser,
  toolFailed,
} from "@domain/agent/tools/failure.js";

/** Where the decisions endpoint lives, and which model answers there. */
const JEV_PINS = {
  url: "https://openrouter.ai/api/alpha/decisions",
  model: "typesafe/jev-1.13",
} as const;

/** One question, in whichever of the three shapes the model chose. */
type JevQuestion = Readonly<Record<string, unknown>>;

/** What one call needs. */
interface JevRequest {
  /** The key, which only ever travels in a header. */
  readonly apiKey: string;
  /** Whatever the model is holding, in whatever shape it holds it. */
  readonly state: unknown;
  /** The questions, by the keys the model chose for them. */
  readonly questions: Readonly<Record<string, JevQuestion>>;
  /** How long the whole call may take, deliveries and backoffs together. */
  readonly budgetMs: number;
  /** How the calling tool names what it does, for the failure sentences. */
  readonly voice: FailureVoice;
  /** The reader's stop, when the caller has one. */
  readonly abortSignal?: AbortSignal;
}

/** What the tool hands back: the keys that read, and the keys that did not. */
export interface JevAnswers {
  /** Each key the endpoint answered, exactly as it answered it. */
  readonly answers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The keys whose answer we could not read, by name. */
  readonly unreadable: readonly string[];
}

/** A number the endpoint means as a probability. */
const probability = z.number().min(0).max(1);

/**
 * One answer of each type, in the shape the endpoint sends it.
 *
 * `noul` carries no confidence, which is the endpoint's shape rather than an
 * omission: it answers one probability and that probability is the whole of
 * what it knows. `score` is the one number with a range of its own -- it may
 * land between rungs, so it is held to the legend it arrived with.
 */
const answerSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("noul"), noul: probability }),
    z.object({
      type: z.literal("choice"),
      choice: z.string(),
      probabilities: z.record(z.string(), probability),
      confidence: probability,
    }),
    z.object({
      type: z.literal("score"),
      score: z.number(),
      legend: z.record(z.string(), z.string()),
      probabilities: z.record(z.string(), probability),
      confidence: probability,
    }),
  ])
  .refine(
    (answer) =>
      answer.type !== "score" ||
      (answer.score >= 0 && answer.score <= Object.keys(answer.legend).length - 1),
    "a score outside its own legend is not a rung",
  );

/**
 * Sort the asked keys into the ones that came back readable and the rest.
 *
 * Walks what was asked rather than what came back, so a question the endpoint
 * skipped is named in `unreadable` instead of vanishing. What goes into
 * `answers` is the value as it arrived, not what the schema parsed out of it:
 * the schema settles whether the model can read the key, and a field this side
 * has not heard of is still the vendor's answer.
 *
 * `answers` has no prototype: a key named `__proto__` is an ordinary own
 * property of a parsed body, and assigning one onto an object literal replaces
 * that object's prototype instead of adding a key.
 * @param asked - The keys the model asked under.
 * @param answered - The `answers` object as it arrived.
 * @returns Both halves.
 */
function sortByReadable(asked: readonly string[], answered: Record<string, unknown>): JevAnswers {
  const answers: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  const unreadable: string[] = [];
  for (const key of asked) {
    // Read through the descriptor: `answered["__proto__"]` runs the inherited
    // getter and answers the prototype, not the key `JSON.parse` put there.
    const value = Object.getOwnPropertyDescriptor(answered, key)?.value as unknown;
    if (answerSchema.safeParse(value).success) answers[key] = value as Record<string, unknown>;
    else unreadable.push(key);
  }
  return { answers, unreadable };
}

/**
 * Read the answered keys off a response body.
 * @param text - The body as it arrived.
 * @param asked - The keys the model asked under.
 * @returns Both halves, or null when the body is not an answer at all.
 */
function readAnswers(text: string, asked: readonly string[]): JevAnswers | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  // `JSON.parse` answers `null` for the literal, and reading a field off that
  // throws a bare TypeError -- which reaches the model as the SDK's "Correct
  // the call and try once more", sending it to rewrite a call that was fine.
  if (typeof body !== "object" || body === null) return null;
  const answered = (body as { answers?: unknown }).answers;
  if (typeof answered !== "object" || answered === null) return null;
  return sortByReadable(asked, answered as Record<string, unknown>);
}

/**
 * Put one set of questions to the endpoint and read what comes back.
 * @param request - Everything the call needs.
 * @returns The keys that read, and the names of the keys that did not.
 * @throws {Error} Carrying tool failure detail, or the reader's stop.
 */
export async function askJev(request: JevRequest): Promise<JevAnswers> {
  const { apiKey, state, questions, budgetMs, voice, abortSignal } = request;
  const moves = nextMovesFor(voice);

  // The budget bounds the call rather than one delivery of it. `replaySafe`
  // settles only the deliveries the caller owns: `decide-retry.ts:287` replays
  // a 429 or a 408 whatever the caller declared, on the protocol's word that
  // the server did not process the request -- so a rate-limited endpoint would
  // hold the turn for three deliveries and two backoffs. This signal is read
  // at the top of every pass (`request.ts:358`) and ends the backoff wait
  // (`request.ts:434`), so the figure in the config is what the reader waits.
  // Truncated because a configured budget can carry a fraction and
  // `AbortSignal.timeout` answers ERR_OUT_OF_RANGE to one, which `setTimeout`
  // does not -- the same trap `read-within.ts:113` records.
  const deadline = AbortSignal.timeout(Math.trunc(budgetMs));
  const spanning = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;

  let res: Response;
  try {
    res = await httpRequest(
      JEV_PINS.url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: JEV_PINS.model, state, questions }),
      },
      { replaySafe: false, timeoutMs: budgetMs, signal: spanning },
    );
  } catch (err: unknown) {
    if (isStop(err, abortSignal)) throw stoppedByUser();
    // The transport's own sentence names the address it was given, which
    // `redactUrl` leaves as origin and path (`redact-url.ts:42`). That is our
    // vendor's identity, it tells the model nothing it can act on, and it is
    // read again by every later turn off the stored row -- so what the model
    // gets is the fact instead.
    throw toolFailed(
      reason(`Nothing answered the ${voice.act} request in time.`, moves.retryOnce),
      FAILURE_LINES.unreachable,
    );
  }

  if (!res.ok) {
    // A body nobody reads keeps its connection out of the pool. Discarding the
    // promise is safe only while nothing awaits between the transport handing
    // this response back and this line.
    void res.body?.cancel();
    // The shared table, which already separates a fault of ours from a request
    // the service would take in another form. The model wrote this request, so
    // that difference decides whether it may write another one.
    // The keys are the model's own words, and this sentence is stored on the
    // call and read again by every later turn -- the same treatment the search
    // tools give a query before it reaches here.
    const asked = clip(keepInside(onOneLine(Object.keys(questions).join(", "))), 200);
    // 422 alone is read differently here. The shared table calls it a fault in
    // our configuration, which holds for a caller that shaped the request; the
    // model shaped this one, so it is one the model can shape again.
    throw toolFailed(
      res.status === 422
        ? reason(
            `${voice.attempting} "${asked}" failed: the ${voice.act} service would not take what was sent.`,
            moves.rewordOnce,
          )
        : refusalReason(voice, asked, res.status),
      FAILURE_LINES.upstream,
    );
  }

  let text: string;
  try {
    text = await readWithin(res, budgetMs, spanning);
  } catch (err: unknown) {
    // Asked here rather than left to the caller's guard, which never sees
    // this: that guard passes anything carrying failure detail straight
    // through, past the question of whether the user stopped.
    if (isStop(err, abortSignal)) throw stoppedByUser();
    throw toolFailed(
      reason(`The ${voice.act} answer could not be read: ${reasonOf(err)}.`, moves.retryOnce),
      FAILURE_LINES.upstream,
    );
  }

  const split = readAnswers(text, Object.keys(questions));
  if (split === null || Object.keys(split.answers).length === 0) {
    throw toolFailed(
      reason(`The ${voice.act} service answered, and none of it could be read.`, moves.stop),
      FAILURE_LINES.upstream,
    );
  }
  return split;
}
