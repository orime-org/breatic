// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import { inputRefusalText, type InputRefusalShape, type ModelEntry, type RunRoute } from '@breatic/shared';
import type { CreditEstimate, EstimateInput } from '@breatic/shared/pricing';

import { ownKeyText, useKeyPlan } from '@web/features/byok/byok-query';
import { useTranslation } from '@web/i18n/use-translation';
import { creditEstimateText } from '@web/spaces/canvas/generate/credit-estimate-text';

/** The route a run takes when the user names none: the deployment's weights. */
const DEFAULT_ROUTE: RunRoute = { mode: 'default' };

/** What provider's rules say about one run as set up. */
export interface RunAnswer {
  /** What it would cost on the upstream its route would choose; undefined when no upstream here can price it. */
  estimate: CreditEstimate | undefined;
  /**
   * Why no upstream here that the route may use takes it (#1521); undefined while one does, when none is configured
   * (servability answers that), and until it resolves.
   */
  refusal: InputRefusalShape | undefined;
  /** Whether the run describes an input on a language model first (Kling O3's elements), a call charged on our keys. */
  describes: boolean;
}

const NO_ANSWER: RunAnswer = { estimate: undefined, refusal: undefined, describes: false };

/**
 * What one run as set up would cost on the upstream its route would choose, and why no upstream here takes it when
 * none does, asked of provider's rules for the model the way the server asks before it holds anything. One load of
 * the rules and one layout of the run answer both.
 *
 * The pricing entries carry the formula evaluator, so they load on first use
 * rather than with the page. The answer is dropped when the model or the run
 * changed while it was being worked out.
 * @param model - The selected model, or undefined when none is picked yet.
 * @param input - The run as it will be sent: params, prompt and known source lengths.
 * @param creditMultiplier - Credits per US cent, off the catalog.
 * @param route - How the run chooses its upstream, the same value its request carries.
 * @returns The estimate and the refusal; both undefined until they resolve, without a model, or when the rules do
 *   not parse.
 */
export function useRunAnswer(
  model: ModelEntry | undefined,
  input: EstimateInput,
  creditMultiplier: number,
  route: RunRoute = DEFAULT_ROUTE,
): RunAnswer {
  const [answer, setAnswer] = React.useState<RunAnswer>(NO_ANSWER);
  // The input and route are rebuilt on every render; their content is what the answer follows.
  const key = JSON.stringify({ input, route });

  React.useEffect(() => {
    if (!model) {
      setAnswer(NO_ANSWER);
      return undefined;
    }
    let current = true;
    const asked = JSON.parse(key) as { input: EstimateInput; route: RunRoute };
    void Promise.all([import('@breatic/provider/pricing'), import('@breatic/shared/pricing')])
      .then(async ([{ describesInput, estimateCost, inputRefusal, parsePricingRules }, { creditEstimateOf, prepareRunParams }]) => {
        const rules = parsePricingRules(model.pricing_rules);
        const prepared = prepareRunParams(model, asked.input);
        const [cost, refusal] = await Promise.all([
          estimateCost(rules, model.availability, prepared, asked.route),
          inputRefusal(rules, model.availability, prepared, asked.route),
        ]);
        return { estimate: creditEstimateOf(cost, creditMultiplier), refusal: refusal ?? undefined, describes: describesInput(rules, prepared.params) };
      })
      .then(
        (next) => {
          if (current) setAnswer(next);
        },
        () => {
          // Rules that do not parse leave the star with nothing and refuse
          // nothing; the server asks again before it holds anything. A formula
          // or condition the evaluator cannot run does not land here: provider
          // counts that upstream as refusing the run.
          if (current) setAnswer(NO_ANSWER);
        },
      );
    return () => {
      current = false;
    };
  }, [model, key, creditMultiplier]);

  return answer;
}

/** What a generation entry shows and says about one run as set up. */
export interface RunCheck {
  /** What prints beside the star; undefined until the estimate resolves. */
  creditText: string | undefined;
  /** What a press says when no upstream here takes the run (#1521), in the user's language. */
  refusalText: string | undefined;
  /** The last refusal sentence rendered, for a click handler that reads it outside render. */
  latestRefusal: React.RefObject<string | undefined>;
}

/**
 * The estimate and the refusal of one run as set up, as a generation entry shows and says them.
 *
 * A model the project's payer runs on their own key (inner#1953) costs no credits, so the entry says whose key it
 * uses instead of a figure, and the refusal is asked of that one upstream with the availability counted on the
 * payer's keys: an upstream the deployment has no key for still answers it.
 * @param model - The selected model, or undefined when none is picked yet.
 * @param input - The run as it will be sent.
 * @param creditMultiplier - Credits per US cent, off the catalog.
 * @param projectId - The project the entry is in, whose key plan decides whose key runs it; empty or undefined reads
 *   none and prices on the deployment's weights.
 * @returns The estimate's text, the refusal sentence and a ref to the latest one.
 */
export function useRunCheck(
  model: ModelEntry | undefined,
  input: EstimateInput,
  creditMultiplier: number,
  projectId?: string,
): RunCheck {
  // Read so both sentences follow an in-session language switch.
  const t = useTranslation();
  const project = projectId === '' ? undefined : projectId;
  const plan = useKeyPlan(project);
  const onKey = model === undefined ? undefined : plan.data?.models[model.name];
  const asked = React.useMemo(
    () => (model === undefined || onKey === undefined ? model : { ...model, availability: onKey.availability }),
    [model, onKey],
  );
  const upstream = onKey?.upstream;
  const route = React.useMemo<RunRoute>(
    () => (upstream === undefined ? DEFAULT_ROUTE : { mode: 'upstream', upstream }),
    [upstream],
  );
  const { estimate, refusal, describes } = useRunAnswer(asked, input, creditMultiplier, route);
  const refusalText = refusal === undefined || model === undefined ? undefined : inputRefusalText(refusal, model.display_name);
  const latestRefusal = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    latestRefusal.current = refusalText;
  }, [refusalText]);
  let creditText: string | undefined;
  if (onKey !== undefined) {
    // The media is on the payer's key; describing its inputs is charged while the language model runs on ours.
    const describedOnCredits = describes && plan.data?.llm.usesAccountKey !== true;
    creditText = ownKeyText(plan.data?.payer ?? 'self', t, describedOnCredits);
  } else if (project === undefined || !plan.isPending) {
    // Nothing prints until the plan says whose key runs it, so a figure never flashes before "no credits". A plan
    // that failed to load prices on the platform key, which the server charges by when it cannot read one either.
    creditText = estimate ? creditEstimateText(estimate, t) : undefined;
  }
  return { creditText, refusalText, latestRefusal };
}
