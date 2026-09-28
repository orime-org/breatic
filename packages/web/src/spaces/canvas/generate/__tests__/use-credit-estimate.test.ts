// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The panels' estimate: the shared pricing function run on the model and the
 * run as set up, answered once it resolves, and nothing without a priced
 * model (#2156).
 */

import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import type { ModelEntry } from '@breatic/shared';

import { useCreditEstimate } from '@web/spaces/canvas/generate/use-credit-estimate';

const MIDJOURNEY = {
  name: 'midjourney',
  takes_prompt: true,
  params: { hd: { description: '', default: true, fill: 'none' } },
  pricing: {
    base_price: 100_000,
    formula: '{"total_price": base_price * (hd ? 1.5 : 1)}',
    discount_rate: 100,
  },
} as unknown as ModelEntry;

describe('useCreditEstimate', () => {
  it('answers the estimate of the run as set up', async () => {
    const { result } = renderHook(() => useCreditEstimate(MIDJOURNEY, { params: {} }, 1));

    await waitFor(() => expect(result.current).toEqual({ credits: 15, bound: 'exact' }));
  });

  it('follows the params the reader changes', async () => {
    const { result, rerender } = renderHook(
      ({ hd }: { hd: boolean }) => useCreditEstimate(MIDJOURNEY, { params: { hd } }, 1),
      { initialProps: { hd: true } },
    );
    await waitFor(() => expect(result.current?.credits).toBe(15));

    rerender({ hd: false });

    await waitFor(() => expect(result.current?.credits).toBe(10));
  });

  it('answers nothing for a model with no pricing', () => {
    const unpriced = { ...MIDJOURNEY, pricing: undefined } as unknown as ModelEntry;
    const { result } = renderHook(() => useCreditEstimate(unpriced, { params: {} }, 1));

    expect(result.current).toBeUndefined();
  });
});
