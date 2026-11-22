// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The panels' estimate: the run as set up, prepared by shared and priced by provider's rules for the model on the
 * upstream its route would choose, answered once it resolves, and nothing where no upstream can price it (#2156,
 * inner#1743).
 */

import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import type { ModelEntry } from '@breatic/shared';

import { useRunAnswer } from '@web/spaces/canvas/generate/use-credit-estimate';

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

describe('useRunAnswer — the estimate', () => {
  it('answers the estimate of the run as set up on the upstream the weights choose', async () => {
    const { result } = renderHook(() => useRunAnswer(MIDJOURNEY, { params: {} }, 1).estimate);

    await waitFor(() => expect(result.current).toEqual({ credits: 15, bound: 'exact' }));
  });

  it('follows the params the user changes', async () => {
    const { result, rerender } = renderHook(
      ({ hd }: { hd: boolean }) => useRunAnswer(MIDJOURNEY, { params: { hd } }, 1).estimate,
      { initialProps: { hd: true } },
    );
    await waitFor(() => expect(result.current?.credits).toBe(15));

    rerender({ hd: false });

    await waitFor(() => expect(result.current?.credits).toBe(10));
  });

  it('prices the upstream the route names', async () => {
    const { result } = renderHook(() => useRunAnswer(MIDJOURNEY, { params: {} }, 1, { mode: 'upstream', upstream: 'fal' }).estimate);

    await waitFor(() => expect(result.current).toEqual({ credits: 10, bound: 'exact' }));
  });

  it('answers nothing when no upstream here can serve the model', async () => {
    const unserved = {
      ...MIDJOURNEY,
      availability: { upstreams: [{ upstream: 'wavespeed', weight: 1, configured: false, envVar: 'WAVESPEED_API_KEY' }] },
    } as unknown as ModelEntry;
    const { result } = renderHook(() => useRunAnswer(unserved, { params: {} }, 1).estimate);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBeUndefined();
  });

  it('answers nothing for rules that do not parse', async () => {
    const broken = { ...MIDJOURNEY, pricing_rules: { model: 'midjourney' } } as unknown as ModelEntry;
    const { result } = renderHook(() => useRunAnswer(broken, { params: {} }, 1).estimate);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBeUndefined();
  });
});

describe('useRunAnswer — the refusal (#1521)', () => {
  const capped = {
    ...MIDJOURNEY,
    pricing_rules: {
      model: 'midjourney',
      upstreams: [{ ...rule('wavespeed', '{"total_price": base_price}'), prompt_field: 'text', rejects: [{ when: '$length(text) > 5', reason: 'WaveSpeed text maxLength 5', limit: { field: 'prompt', measure: 'characters', max: 5 } }] }],
    },
    availability: { upstreams: [{ upstream: 'wavespeed', weight: 1, configured: true, envVar: 'WAVESPEED_API_KEY' }] },
  } as unknown as ModelEntry;

  it('answers the refusal, with its limit, of a run no upstream here takes', async () => {
    const { result } = renderHook(() => useRunAnswer(capped, { params: {}, prompt: 'abcdef' }, 1).refusal);

    await waitFor(() => expect(result.current).toEqual({ reason: 'WaveSpeed text maxLength 5', limit: { field: 'prompt', measure: 'characters', max: 5 } }));
  });

  it('answers nothing once the run fits, following what the user writes', async () => {
    const { result, rerender } = renderHook(({ prompt }: { prompt: string }) => useRunAnswer(capped, { params: {}, prompt }, 1).refusal, { initialProps: { prompt: 'abcdef' } });
    await waitFor(() => expect(result.current).not.toBeUndefined());

    rerender({ prompt: 'abc' });

    await waitFor(() => expect(result.current).toBeUndefined());
  });

  it('answers nothing without a model or for rules that do not parse', async () => {
    const broken = { ...capped, pricing_rules: { model: 'midjourney' } } as unknown as ModelEntry;
    const { result } = renderHook(() => useRunAnswer(broken, { params: {}, prompt: 'abcdef' }, 1).refusal);
    const none = renderHook(() => useRunAnswer(undefined, { params: {}, prompt: 'abcdef' }, 1).refusal);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBeUndefined();
    expect(none.result.current).toBeUndefined();
  });
});

describe('useRunAnswer — one answer for both (#1521)', () => {
  it('answers the estimate and the refusal of one run from one load of the rules', async () => {
    const capped = {
      ...MIDJOURNEY,
      pricing_rules: {
        model: 'midjourney',
        upstreams: [{ ...rule('wavespeed', '{"total_price": base_price}'), prompt_field: 'text', rejects: [{ when: '$length(text) > 5', reason: 'r', limit: { field: 'prompt', measure: 'characters', max: 5 } }] }],
      },
      availability: { upstreams: [{ upstream: 'wavespeed', weight: 1, configured: true, envVar: 'WAVESPEED_API_KEY' }] },
    } as unknown as ModelEntry;
    const { result } = renderHook(() => useRunAnswer(capped, { params: {}, prompt: 'abc' }, 1));

    await waitFor(() => expect(result.current).toEqual({ estimate: { credits: 10, bound: 'exact' }, refusal: undefined }));
  });
});
