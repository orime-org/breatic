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
  notOurPayloadReason,
  onOneLine,
  readFailedReason,
  reason,
  refusalReason,
  stoppedByUser,
  toolFailed,
} from "@domain/agent/tools/failure.js";

/**
 * How this tool names what it does, in the sentences a failure carries.
 *
 * The fallback says what to do instead rather than what to announce: a
 * judgement is the model's own deliberation, and the reader asked for the
 * work rather than for this.
 */
const voice: FailureVoice = {
  act: "judgement",
  results: "that judgement",
  retrying: "Asking once more",
  elsewhere: "decide from what you already hold",
  attempting: "Judging",
  fallback: "continue without that judgement and decide from what you already hold.",
};

/** The moves a failure of this tool points the model at. */
const moves = nextMovesFor(voice);

/**
 * How long to wait for the endpoint's own words about a refusal.
 *
 * The sentence is complete when the status arrives; what the service said is
 * an addition to it. So this is short on purpose: a body that has not arrived
 * in this long is not worth holding the reader for, and the call's own budget
 * would hold them for all of it. Not a knob anyone would tune -- it answers
 * "how long is a decoration worth", not "how long may this call take".
 */
const COMPLAINT_READ_MS = 500;

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
 * what it knows. What this settles is whether the model can read the key --
 * where a score falls within its own legend is the endpoint's answer, and the
 * legend arrives beside it for the model to read.
 */
const answerSchema = z.discriminatedUnion("type", [
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
]);

/**
 * Sort the asked keys into the ones that came back readable and the rest.
 *
 * Walks what was asked rather than what came back, so a question the endpoint
 * skipped is named in `unreadable` instead of vanishing. What goes into
 * `answers` is the value as it arrived, not what the schema parsed out of it:
 * the schema settles whether the model can read the key, and a field this side
 * has not heard of is still the vendor's answer.
 * @param asked - The keys the model asked under.
 * @param answered - The `answers` object as it arrived.
 * @returns Both halves.
 */
function sortByReadable(asked: readonly string[], answered: Record<string, unknown>): JevAnswers {
  const answers: Record<string, Record<string, unknown>> = {};
  const unreadable: string[] = [];
  for (const key of asked) {
    const value = answered[key];
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
 * What the endpoint said it would not take, in its own words.
 *
 * Read off a refusal because it names the field it refused -- measured,
 * `path:["questions","a","criteria"] expected array` for a scale given a map,
 * and `Choice question must have at least one choice: <key>` for an empty
 * option set. The model wrote the request and is the one that can rewrite it.
 *
 * Only `error.message` travels. The body also carries `user_id`, which is who
 * we are to the vendor and says nothing the model can act on.
 * @param res - The refusal, body unread.
 * @param abortSignal - The reader's stop, when the caller has one.
 * @param signal - The signal spanning the call.
 * @returns The complaint, or an empty string when there is none to read.
 * @throws {Error} The reader's stop, which outranks anything the service said.
 */
async function complaintOf(
  res: Response,
  abortSignal: AbortSignal | undefined,
  signal: AbortSignal,
): Promise<string> {
  let said: unknown;
  try {
    // The figure goes in as the read's own budget, which `readWithin` turns
    // into a clock of its own and ors with the spanning signal
    // (`read-within.ts`), so the reader waits the shorter of the two.
    said = JSON.parse(await readWithin(res, COMPLAINT_READ_MS, signal));
  } catch (err: unknown) {
    // Asked before the read is written off: a stop that landed inside it is
    // what the reader did, and that outranks what the service said.
    if (isStop(err, abortSignal)) throw stoppedByUser();
    return "";
  }
  if (typeof said !== "object" || said === null) return "";
  const message = (said as { error?: { message?: unknown } }).error?.message;
  return typeof message === "string" ? clip(keepInside(onOneLine(message)), 400) : "";
}

/**
 * Put one set of questions to the endpoint and read what comes back.
 * @param request - Everything the call needs.
 * @returns The keys that read, and the names of the keys that did not.
 * @throws {Error} Carrying tool failure detail, or the reader's stop.
 */
export async function askJev(request: JevRequest): Promise<JevAnswers> {
  const { apiKey, state, questions, budgetMs, abortSignal } = request;
  // The keys are the model's own words, and every sentence below is stored on
  // the call and read again by every later turn -- the same treatment the
  // search tools give a query before it reaches one.
  const asked = clip(keepInside(onOneLine(Object.keys(questions).join(", "))), 200);

  // The budget bounds the call rather than one delivery of it. `replaySafe`
  // settles only the deliveries the caller owns: `decide-retry.ts:287` replays
  // a 429 or a 408 whatever the caller declared, on the protocol's word that
  // the server did not process the request -- so a rate-limited endpoint would
  // hold the turn for three deliveries and two backoffs. This signal is read
  // at the top of every pass (`request.ts:358`) and ends the backoff wait
  // (`request.ts:434`), so the figure in the config is what the reader waits.
  // Truncated because this is a plain number parameter and `AbortSignal.timeout`
  // answers ERR_OUT_OF_RANGE to a fraction, which `setTimeout` does not
  // (`read-within.ts:113`). The one caller reads an integer from the config.
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
    // A raised signal settles the retry (`request.ts:401`) and the transport
    // hands back the response it is holding (`:415`) rather than throwing, so
    // a stop that landed mid-refusal arrives here looking like an upstream
    // fault. What the reader did outranks what the service said.
    if (abortSignal?.aborted === true) {
      // A body nobody reads keeps its connection out of the pool.
      void res.body?.cancel();
      throw stoppedByUser();
    }
    const complaint = await complaintOf(res, abortSignal, spanning);
    // Which of the two this is, the status cannot always say. The model
    // composed this body, so a 422 -- which the shared table reads as a fault
    // in our configuration -- is one it may compose again. And a refusal that
    // names the model pinned in this file is our doing whatever its number:
    // measured, an unknown name answers 400, the same as a malformed question.
    // Three answers, not two: this side knows about exactly two statuses, and
    // every other one is the shared table's to sort.
    const rewordable = complaint.includes(JEV_PINS.model)
      ? false
      : res.status === 422
        ? true
        : undefined;
    throw toolFailed(
      refusalReason(voice, asked, res.status, complaint, rewordable),
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
    // The budget covers the body as well as the deliveries, so a sender that
    // writes its headers and then stops ends here with the whole figure spent.
    // That is the same fact as nothing answering at all, and says so.
    if (spanning.aborted) {
      throw toolFailed(
        reason(`Nothing answered the ${voice.act} request in time.`, moves.retryOnce),
        FAILURE_LINES.unreachable,
      );
    }
    throw toolFailed(
      readFailedReason(voice, asked, reasonOf(err)),
      FAILURE_LINES.upstream,
    );
  }

  const split = readAnswers(text, Object.keys(questions));
  if (split === null) {
    throw toolFailed(notOurPayloadReason(voice, asked), FAILURE_LINES.upstream);
  }
  // Every key unreadable is the same fact as one of them being unreadable, and
  // A4's answer to it is the same: the names travel and the model decides.
  return split;
}
