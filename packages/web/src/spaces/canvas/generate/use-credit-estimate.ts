// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';
import type { CreditEstimate, EstimateInput } from '@breatic/shared/pricing';

/**
 * What one run as set up would cost, priced by the model's contract.
 *
 * The pricing entry carries the formula evaluator, so it loads on first use
 * rather than with the page. The answer is dropped when the model or the run
 * changed while it was being computed.
 * @param model - The selected model, or undefined when none is picked yet.
 * @param input - The run as set up: params, prompt and known source lengths.
 * @param creditMultiplier - Credits per US cent, off the catalog.
 * @returns The estimate, or undefined until it resolves or without a priced model.
 */
export function useCreditEstimate(
  model: ModelEntry | undefined,
  input: EstimateInput,
  creditMultiplier: number,
): CreditEstimate | undefined {
  const [estimate, setEstimate] = React.useState<CreditEstimate | undefined>(undefined);
  // The input is rebuilt on every render; its content is what the answer follows.
  const key = JSON.stringify(input);
  const pricing = model?.pricing;

  React.useEffect(() => {
    if (!model || !pricing) {
      setEstimate(undefined);
      return undefined;
    }
    let current = true;
    const run = JSON.parse(key) as EstimateInput;
    void import('@breatic/shared/pricing')
      .then(({ estimateCredits }) => estimateCredits({ ...model, pricing }, run, creditMultiplier))
      .then(
        (next) => {
          if (current) setEstimate(next);
        },
        () => {
          // A formula the evaluator cannot run leaves the star with nothing
          // rather than a wrong number; the run itself is billed on usage.
          if (current) setEstimate(undefined);
        },
      );
    return () => {
      current = false;
    };
  }, [model, pricing, key, creditMultiplier]);

  return estimate;
}
