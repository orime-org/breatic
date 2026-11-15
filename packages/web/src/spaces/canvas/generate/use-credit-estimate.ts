// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { inputRefusalText, type InputRefusalShape, type ModelEntry, type RunRoute } from '@breatic/shared';
import type { CreditEstimate, EstimateInput } from '@breatic/shared/pricing';

import { useTranslation } from '@web/i18n/use-translation';
import { creditEstimateText } from '@web/spaces/canvas/generate/credit-estimate-text';

/** The route a run takes when the user names none: the deployment's weights. */
const DEFAULT_ROUTE: RunRoute = { mode: 'default' };

/**
 * What one run as set up would cost on the upstream its route would choose, priced by provider's rules for the
 * model the way the server prices it.
 *
 * The pricing entries carry the formula evaluator, so they load on first use
 * rather than with the page. The answer is dropped when the model or the run
 * changed while it was being computed.
 * @param model - The selected model, or undefined when none is picked yet.
 * @param input - The run as set up: params, prompt and known source lengths.
 * @param creditMultiplier - Credits per US cent, off the catalog.
 * @param route - How the run chooses its upstream, the same value its request carries.
 * @returns The estimate, or undefined until it resolves, without a model, or when no upstream here can serve it.
 */
export function useCreditEstimate(
  model: ModelEntry | undefined,
  input: EstimateInput,
  creditMultiplier: number,
  route: RunRoute = DEFAULT_ROUTE,
): CreditEstimate | undefined {
  const [estimate, setEstimate] = React.useState<CreditEstimate | undefined>(undefined);
  // The input and route are rebuilt on every render; their content is what the answer follows.
  const key = JSON.stringify({ input, route });

  React.useEffect(() => {
    if (!model) {
      setEstimate(undefined);
      return undefined;
    }
    let current = true;
    const asked = JSON.parse(key) as { input: EstimateInput; route: RunRoute };
    void Promise.all([import('@breatic/provider/pricing'), import('@breatic/shared/pricing')])
      .then(async ([{ estimateCost, parsePricingRules }, { creditEstimateOf, prepareRunParams }]) =>
        creditEstimateOf(
          await estimateCost(parsePricingRules(model.pricing_rules), model.availability, prepareRunParams(model, asked.input), asked.route),
          creditMultiplier,
        ))
      .then(
        (next) => {
          if (current) setEstimate(next);
        },
        () => {
          // Rules that do not parse or a formula the evaluator cannot run leave
          // the star with nothing rather than a wrong number; the run itself is
          // billed on usage.
          if (current) setEstimate(undefined);
        },
      );
    return () => {
      current = false;
    };
  }, [model, key, creditMultiplier]);

  return estimate;
}

/**
 * Why no upstream here that the route may use takes the run as set up (#1521), asked of provider's rules the way the
 * server asks before it holds anything, so the panel can say which limit the run breaks before the user presses.
 * Loaded with the estimate's rules; the answer is dropped when the model or the run changed while it was worked out.
 * @param model - The selected model, or undefined when none is picked yet.
 * @param input - The run as set up: params, prompt and known source lengths.
 * @param route - How the run chooses its upstream, the same value its request carries.
 * @returns The refusal, or undefined while one upstream takes the run, without a model, or when the rules do not parse.
 */
export function useInputRefusal(
  model: ModelEntry | undefined,
  input: EstimateInput,
  route: RunRoute = DEFAULT_ROUTE,
): InputRefusalShape | undefined {
  const [refusal, setRefusal] = React.useState<InputRefusalShape | undefined>(undefined);
  // The input and route are rebuilt on every render; their content is what the answer follows.
  const key = JSON.stringify({ input, route });

  React.useEffect(() => {
    if (!model) {
      setRefusal(undefined);
      return undefined;
    }
    let current = true;
    const asked = JSON.parse(key) as { input: EstimateInput; route: RunRoute };
    void Promise.all([import('@breatic/provider/pricing'), import('@breatic/shared/pricing')])
      .then(([{ inputRefusal, parsePricingRules }, { prepareRunParams }]) =>
        inputRefusal(parsePricingRules(model.pricing_rules), model.availability, prepareRunParams(model, asked.input), asked.route))
      .then(
        (next) => {
          if (current) setRefusal(next ?? undefined);
        },
        () => {
          // Rules that do not parse refuse nothing here; the server asks again before it holds anything.
          if (current) setRefusal(undefined);
        },
      );
    return () => {
      current = false;
    };
  }, [model, key]);

  return refusal;
}

/**
 * The sentence a panel's Generate says when no upstream here takes the run as set up (#1521), in the user's language,
 * and a ref holding the last one rendered for the click handler, which reads it outside render.
 * @param model - The selected model, or undefined when none is picked yet.
 * @param input - The run as set up, the same value the estimate prices.
 * @param route - How the run chooses its upstream, the same value its request carries.
 * @returns The sentence, undefined while the run is taken, and the ref.
 */
export function useInputRefusalText(
  model: ModelEntry | undefined,
  input: EstimateInput,
  route: RunRoute = DEFAULT_ROUTE,
): { text: string | undefined; latest: React.RefObject<string | undefined> } {
  // Read so the sentence follows an in-session language switch.
  useTranslation();
  const refusal = useInputRefusal(model, input, route);
  const text = refusal === undefined || model === undefined ? undefined : inputRefusalText(refusal, model.display_name);
  const latest = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    latest.current = text;
  }, [text]);
  return { text, latest };
}

/**
 * What the panel prints beside the star for the run as set up.
 * @param model - The selected model, or undefined when none is picked yet.
 * @param input - The run as set up: params, prompt and known source lengths.
 * @param creditMultiplier - Credits per US cent, off the catalog.
 * @returns The text, or undefined until the estimate resolves.
 */
export function useCreditText(
  model: ModelEntry | undefined,
  input: EstimateInput,
  creditMultiplier: number,
): string | undefined {
  const t = useTranslation();
  const estimate = useCreditEstimate(model, input, creditMultiplier);
  return estimate ? creditEstimateText(estimate, t) : undefined;
}
