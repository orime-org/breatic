// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * WaveSpeed: a submit is `POST {base_url}/{model_id}` and may
 * answer the outputs at once; a prediction is asked about at
 * `GET /predictions/{id}/result`; what it cost is a billing search. The
 * upstream has no client key, so a send whose answer was lost cannot be
 * looked up (recovery `none`).
 */

import { z } from "zod";
import type { Cost } from "@provider/cost.js";
import { BilledAnswerLost } from "@provider/errors.js";
import { NoAnswer, type HttpStatus } from "@provider/http/errors.js";
import { fetchJson, parsed } from "@provider/http/request.js";
import {
  bearerHeaders as headers,
  billingFailure,
  readOptions,
  minimaxVoiceGone,
  outputField,
  outputUrls,
  submitText,
  unbilled,
  type Asked,
  type MediaAdapter,
  type Reach,
  type Refusal,
  type RequestBounds,
  type StepCodec,
  type Submitted,
} from "@provider/media/adapter.js";
import type { MediaWarning } from "@provider/media/runner.js";
import { readBilling } from "@provider/media/wavespeed/billing.js";
import { buildBody } from "@provider/media/body.js";

/**
 * How the upstream says a cloned id it once gave is gone, by clone kind (the
 * error text probed 2026-09-28 for voice, 2026-09-29 for element). Mureka
 * answers an unknown vocal with the words it uses for any refused input, so
 * vocal has no rule.
 */
const GONE: Readonly<Partial<Record<string, (message: string, id: string) => boolean>>> = {
  voice: minimaxVoiceGone,
  element: (message, id) => /Element id not found: (\S+)/.exec(message)?.[1] === id,
};

/** A submit answer, as far as it is read. */
const submittedSchema = z.looseObject({
  data: z.looseObject({ id: z.string().optional(), outputs: z.array(z.unknown()).nullish() }),
});

/**
 * A prediction's result answer, as far as it is read. Like today's poll, a part it cannot
 * read reads as absent: no readable status is still running, outputs that are not a list none.
 */
const resultSchema = z.looseObject({
  data: z.looseObject({
    status: z.string().optional().catch(undefined),
    outputs: z.array(z.unknown()).optional().catch(undefined),
    error: z.unknown().optional(),
  }).optional().catch(undefined),
});

/**
 * Submit one prediction; resent only on a 408 or 429, which the upstream did not process.
 * A 2xx whose answer cannot be read (cut, not JSON, no id and no outputs) is NoAnswer: sent,
 * outcome unknown.
 * @param reach - The upstream.
 * @param endpoint - The model path.
 * @param body - The request body.
 * @param bounds - The deadline and signal.
 * @returns The prediction id, and the outputs when it finished at once.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {NoAnswer} With a BilledAnswerLost cause carrying one missing cost, when a 2xx answer cannot be read.
 */
async function submit(reach: Reach, endpoint: string, body: Record<string, unknown>, bounds: RequestBounds): Promise<Submitted> {
  const url = `${reach.decl.base_url}/${endpoint}`;
  const text = await submitText(reach, url, body, headers(reach), bounds);
  const read = submittedSchema.safeParse(parsed(text));
  const id = read.success && read.data.data.id !== "" ? read.data.data.id : undefined;
  const outputs = read.success && (read.data.data.outputs ?? []).length > 0 ? read.data.data.outputs! : undefined;
  if (id === undefined && outputs === undefined) throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} answered no prediction id and no outputs it could read`));
  return { predictionId: id, outputs };
}

/**
 * Ask once about a prediction.
 * @param reach - The upstream.
 * @param predictionId - The prediction.
 * @param bounds - The deadline and signal.
 * @returns Whether it is running, done with its outputs, or failed with the upstream's words.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {SyntaxError} When a 2xx answer is not JSON.
 */
async function ask(reach: Reach, predictionId: string, bounds: RequestBounds): Promise<Asked> {
  const answer = await fetchJson(
    { url: `${reach.decl.base_url}/predictions/${encodeURIComponent(predictionId)}/result`, method: "GET", headers: headers(reach) },
    readOptions(bounds),
  );
  const parsed = resultSchema.safeParse(answer);
  const data = parsed.success ? parsed.data.data : undefined;
  if (data === undefined) return { state: "running" };
  if (data.status === "completed") return { state: "done", outputs: data.outputs ?? [] };
  // As today's poll: the upstream's error as text whatever its type, "unknown" when it gave none.
  if (data.status === "failed") return { state: "failed", error: data.error === undefined || data.error === null ? "unknown" : String(data.error) };
  return { state: "running" };
}

/**
 * What a finished prediction cost, from the billing search.
 * @param reach - The upstream.
 * @param predictionId - The prediction.
 * @param bounds - The deadline and signal.
 * @param lastAttempt - Whether no later lookup follows: an answer without a total is then missing, not pending.
 * @returns The cost and anything to log.
 */
async function billed(reach: Reach, predictionId: string, bounds: RequestBounds, lastAttempt: boolean): Promise<{ cost: Cost; warnings: MediaWarning[] }> {
  let body: unknown;
  try {
    body = await fetchJson(
      { url: `${reach.decl.base_url}/billings/search`, method: "POST", headers: headers(reach), body: JSON.stringify({ prediction_uuids: [predictionId] }) },
      readOptions(bounds),
    );
  } catch (error) {
    const code = billingFailure(error);
    return { cost: unbilled(reach, predictionId, lastAttempt, code), warnings: [{ code, detail: { upstream: reach.name, predictionId, error: String(error) } }] };
  }
  const read = readBilling(body);
  if (read.kind === "none") {
    return { cost: unbilled(reach, predictionId, lastAttempt, "billing_query_empty"), warnings: [...read.warnings, { code: "billing_query_empty", detail: { upstream: reach.name, predictionId } }] };
  }
  return { cost: { state: "known", usd: read.usd, source: "billing" }, warnings: read.warnings };
}

/** WaveSpeed's message for a model id it does not serve (measured 2026-10-26, a 400). */
const MODEL_NOT_FOUND = "Model not found.";

/**
 * What a refused submit says: WaveSpeed's no-such-model answer is a 400 told
 * apart from a refusal of the request's params by its message.
 * @param error - The refusal.
 * @returns `model_not_found` for that answer, otherwise nothing.
 */
function refusal(error: HttpStatus): Refusal {
  if (error.status !== 400) return undefined;
  return (parsed(error.body) as { message?: unknown } | null | undefined)?.message === MODEL_NOT_FOUND ? "model_not_found" : undefined;
}

/**
 * Whether the upstream's failure says a cached clone is gone.
 * @param kind - The clone's kind.
 * @param message - The upstream's words.
 * @param id - The clone's upstream id.
 * @returns True when the clone should be retired.
 */
function gone(kind: string, message: string, id: string): boolean {
  return GONE[kind]?.(message, id) === true;
}

/**
 * An upload step: the source sent for a purpose, its id read back.
 * @param purpose - `reference` or `melody`.
 * @returns The step's codec.
 */
function upload(purpose: string): StepCodec {
  return {
    body: (context) => ({ audio: context.source(), purpose }),
    output: (outputs, context) => ({ param: context.param, id: outputField(outputs, `${purpose}_id`) }),
  };
}

/** WaveSpeed's extra steps: Mureka uploads and vocal clones, MiniMax voice clones and speech, Kling elements. */
const STEPS: MediaAdapter["steps"] = {
  upload_reference: upload("reference"),
  upload_melody: upload("melody"),
  vocal: {
    body: (context) => ({ audio: context.source() }),
    output: (outputs, context) => ({ param: context.param, id: outputField(outputs, "vocal_id") }),
  },
  voice: {
    body: (context) => ({ ...buildBody(context.binding, { params: context.params, prompt: "" }), custom_voice_id: context.customVoiceId }),
    output: (_outputs, context) => ({ voiceId: context.customVoiceId }),
  },
  speak: {
    body: (context) => {
      // A speak step runs only after the voice step's output or a cached clone gave it a voice id.
      /* v8 ignore next -- @preserve */
      if (context.voiceId === undefined) throw new Error("No cloned voice to speak with");
      return { text: context.prompt, voice_id: context.voiceId };
    },
    output: (outputs) => ({ urls: [outputUrls(outputs)[0]!] }),
  },
  element: {
    body: (context) => {
      const image = context.source();
      return { name: `Element ${(context.itemIndex ?? 0) + 1}`, description: context.description ?? "", image, element_refer_list: [image] };
    },
    output: (outputs, context) => ({ index: context.itemIndex ?? 0, elementId: outputField(outputs, "element_id") }),
  },
};

/** WaveSpeed, as the runner and cost lookups reach it. */
export const wavespeedAdapter: MediaAdapter = {
  submit,
  ask,
  billed,
  refusal,
  gone,
  steps: STEPS,
};
