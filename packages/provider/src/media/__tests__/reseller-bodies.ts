// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a reseller request-body sample is built from and checked against, shared by
 * scripts/provider-reseller-bodies.ts and reseller-body-fixture.test.ts.
 */

import type { MediaBinding } from "../../config/schema.js";
import { shipped } from "../../config/__tests__/shipped.js";
import { rejectedInput } from "../../pricing/estimate.js";
import { createProvider } from "../../provider.js";
import { adapterOf } from "../adapters.js";
import { buildBody } from "../body.js";

const config = shipped();
const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });

/** One sample run: our params and prompt, the ids its extra steps answered for the params they serve, and the body sent. */
export interface SampleRun {
  params: Record<string, unknown>;
  prompt: string;
  ids?: Record<string, string>;
  body: Record<string, unknown>;
}

/** The clone id a voice step registers in the samples. */
export const SAMPLE_VOICE_ID = "BreaticSample";

/**
 * Whether the binding takes these params with this prompt.
 * @param model - Our model.
 * @param binding - The binding.
 * @param params - Our params.
 * @param prompt - The prompt.
 * @returns True when no limit, voice map or reject of the binding refuses them.
 */
export async function takes(model: string, binding: MediaBinding, params: Record<string, unknown>, prompt: string): Promise<boolean> {
  return (await rejectedInput(provider.pricingRules(model), binding.upstream, { params, prompt, durations: {}, placeholders: [], durationsMissing: [] })) === undefined;
}

/**
 * The body of a run's first call as the runner sends it: the voice step's when the call clones a source, else the binding's.
 * @param binding - The binding.
 * @param run - The sample run.
 * @returns The body.
 */
export function firstBody(binding: MediaBinding, run: SampleRun): Record<string, unknown> {
  const params = { ...run.params, ...run.ids };
  if (binding.reused_by === undefined) return buildBody(binding, { params, prompt: run.prompt });
  const voice = adapterOf(config.upstreams[binding.upstream]!.kind).steps.voice!;
  return voice.body({ source: () => String(run.params[binding.reused_by!]), params, prompt: run.prompt, binding, customVoiceId: SAMPLE_VOICE_ID, voiceId: undefined, description: undefined, itemIndex: null, param: undefined });
}

