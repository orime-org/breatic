// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import type { ModelEntry, RunRoute } from '@breatic/shared';
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
