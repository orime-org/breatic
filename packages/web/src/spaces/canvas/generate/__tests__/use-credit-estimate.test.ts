// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The panels' estimate: the run as set up, prepared by shared and priced by provider's rules for the model on the
 * upstream its route would choose, answered once it resolves, and nothing where no upstream can price it (#2156,
 * inner#1743).
 */

import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import type { ModelEntry } from '@breatic/shared';

import { useCreditEstimate } from '@web/spaces/canvas/generate/use-credit-estimate';

/** One upstream's rule, as the model list carries it. */
const rule = (upstream: string, formula: string): Record<string, unknown> => ({
  upstream,
  fields: {},
  pricing: { kind: 'formula', base_price: 100_000, formula, discount_rate: 100 },
  steps: [],
});

const MIDJOURNEY = {
  name: 'midjourney',
  takes_prompt: true,
  params: { hd: { description: '', default: true, fill: 'none' } },
  availability: {
    upstreams: [
      { upstream: 'wavespeed', weight: 1, configured: true, envVar: 'WAVESPEED_API_KEY' },
      { upstream: 'fal', weight: 2, configured: true, envVar: 'FAL_KEY' },
    ],
  },
  pricing_rules: {
    model: 'midjourney',
    upstreams: [rule('wavespeed', '{"total_price": base_price * (hd ? 1.5 : 1)}'), rule('fal', '{"total_price": base_price}')],
  },
} as unknown as ModelEntry;

describe('useCreditEstimate', () => {
  it('answers the estimate of the run as set up on the upstream the weights choose', async () => {
    const { result } = renderHook(() => useCreditEstimate(MIDJOURNEY, { params: {} }, 1));

    await waitFor(() => expect(result.current).toEqual({ credits: 15, bound: 'exact' }));
  });

  it('follows the params the user changes', async () => {
    const { result, rerender } = renderHook(
      ({ hd }: { hd: boolean }) => useCreditEstimate(MIDJOURNEY, { params: { hd } }, 1),
      { initialProps: { hd: true } },
    );
    await waitFor(() => expect(result.current?.credits).toBe(15));

    rerender({ hd: false });

    await waitFor(() => expect(result.current?.credits).toBe(10));
  });

  it('prices the upstream the route names', async () => {
    const { result } = renderHook(() => useCreditEstimate(MIDJOURNEY, { params: {} }, 1, { mode: 'upstream', upstream: 'fal' }));

    await waitFor(() => expect(result.current).toEqual({ credits: 10, bound: 'exact' }));
  });

  it('answers nothing when no upstream here can serve the model', async () => {
    const unserved = {
      ...MIDJOURNEY,
      availability: { upstreams: [{ upstream: 'wavespeed', weight: 1, configured: false, envVar: 'WAVESPEED_API_KEY' }] },
    } as unknown as ModelEntry;
    const { result } = renderHook(() => useCreditEstimate(unserved, { params: {} }, 1));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBeUndefined();
  });

  it('answers nothing for rules that do not parse', async () => {
    const broken = { ...MIDJOURNEY, pricing_rules: { model: 'midjourney' } } as unknown as ModelEntry;
    const { result } = renderHook(() => useCreditEstimate(broken, { params: {} }, 1));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBeUndefined();
  });
});
