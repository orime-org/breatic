// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The panels' estimate when the Studio's payer runs a model on their own key (inner#1953).
 *
 * `GET /projects/:id/key-plan` answers, for the Studio the project belongs to, which non-language models run on the
 * payer's own key, on which upstream, and the availability counted on that payer's keys (only that upstream is
 * configured). A model there costs no credits, so the panel says whose key it uses instead of a figure; and it asks
 * provider's rules about that upstream, with that availability, so an upstream the deployment has no key for still
 * answers its refusal.
 *
 * Contract this file assumes:
 *
 *   GET /projects/:id/key-plan -> {      (as `packages/server/src/__tests__/integration/byok-key-plan.integration.test.ts` pins it)
 *     payer: 'self' | 'admin',               // whose key: the viewer's own, or the Studio admin's
 *     llm: { usesAccountKey: boolean },      // language model calls run on the payer's OpenRouter key
 *     models: Record<modelName, { upstream: string, availability: ModelAvailability }>,
 *   }
 *
 *   useRunCheck(model, input, creditMultiplier, projectId)
 */

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ModelAvailability, ModelEntry } from '@breatic/shared';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet,
}));

import { useRunCheck } from '@web/spaces/canvas/generate/use-credit-estimate';

const PROJECT = 'p-1';

/** The key plan's answer. */
interface KeyPlan {
  payer: 'self' | 'admin';
  llm: { usesAccountKey: boolean };
  models: Record<string, { upstream: string; availability: ModelAvailability }>;
}

/** One upstream's rule, as the model list carries it. */
const rule = (upstream: string, formula: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  upstream,
  fields: {},
  pricing: { kind: 'formula', base_price: 100_000, formula, discount_rate: 100 },
  steps: [],
  ...extra,
});

/**
 * A model the deployment serves on WaveSpeed only; fal, which has no deployment key here, refuses a prompt over five
 * characters.
 */
const MIDJOURNEY = {
  name: 'midjourney',
  display_name: 'Midjourney',
  takes_prompt: true,
  params: {},
  availability: {
    upstreams: [
      { upstream: 'wavespeed', weight: 1, configured: true, envVar: 'WAVESPEED_API_KEY' },
      { upstream: 'fal', weight: 2, configured: false, envVar: 'FAL_KEY' },
    ],
  },
  pricing_rules: {
    model: 'midjourney',
    upstreams: [
      rule('wavespeed', '{"total_price": base_price * 1.5}'),
      rule('fal', '{"total_price": base_price}', {
        prompt_field: 'text',
        rejects: [{ when: '$length(text) > 5', reason: 'fal text maxLength 5', limit: { field: 'prompt', measure: 'characters', max: 5 } }],
      }),
    ],
  },
} as unknown as ModelEntry;

/** A model whose WaveSpeed run describes each element on a language model first, a call charged on our keys. */
const DESCRIBING = {
  ...MIDJOURNEY,
  name: 'describing',
  params: { elements: { type: 'list', default: null, accepts: 'image', optional: true } },
  pricing_rules: {
    model: 'describing',
    upstreams: [
      rule('wavespeed', '{"total_price": base_price}', {
        steps: [{ kind: 'element', for_param: 'elements', per_item: true, describes: true }],
      }),
    ],
  },
} as unknown as ModelEntry;

/** On the payer's WaveSpeed key. */
const ON_WAVESPEED: KeyPlan['models'][string] = {
  upstream: 'wavespeed',
  availability: { upstreams: [{ upstream: 'wavespeed', weight: 1, configured: true, envVar: 'WAVESPEED_API_KEY' }] },
};

const WITH_ELEMENT = { params: { elements: ['https://a.example/e.png'] } };

/** On the payer's fal key: fal is the one configured upstream. */
const ON_FAL: KeyPlan['models'][string] = {
  upstream: 'fal',
  availability: { upstreams: [{ upstream: 'fal', weight: 2, configured: true, envVar: 'FAL_KEY' }] },
};

/**
 * Make the key plan answer one plan.
 * @param plan - The plan.
 */
function serve(plan: KeyPlan): void {
  apiGet.mockImplementation((url: string) =>
    url === `/projects/${PROJECT}/key-plan` ? Promise.resolve(plan) : Promise.reject(new Error(`unexpected GET ${url}`)),
  );
}

/**
 * A query client around the hook.
 * @returns The wrapper.
 */
function wrapper(): React.FC<{ children: React.ReactNode }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useRunCheck — the key plan (inner#1953)', () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it('reads the key plan of the project the panel is in', async () => {
    serve({ payer: 'self', llm: { usesAccountKey: false }, models: {} });
    renderHook(() => useRunCheck(MIDJOURNEY, { params: {} }, 1, PROJECT), { wrapper: wrapper() });

    await waitFor(() => expect(apiGet.mock.calls.map((call) => call[0])).toContain(`/projects/${PROJECT}/key-plan`));
  });

  it('prints the credits of a model the payer has not put on their own key', async () => {
    serve({ payer: 'self', llm: { usesAccountKey: true }, models: {} });
    const { result } = renderHook(() => useRunCheck(MIDJOURNEY, { params: {} }, 1, PROJECT), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.creditText).toBe('15'));
  });

  it('says the run uses the viewer’s own key and no credits', async () => {
    serve({ payer: 'self', llm: { usesAccountKey: false }, models: { midjourney: ON_FAL } });
    const { result } = renderHook(() => useRunCheck(MIDJOURNEY, { params: {} }, 1, PROJECT), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.creditText).toBe('Your key'));
    expect(result.current.creditDetail).toBe('Uses your key, no credits');
  });

  it('says the run uses the Studio’s key and no credits when the key is the admin’s', async () => {
    serve({ payer: 'admin', llm: { usesAccountKey: false }, models: { midjourney: ON_FAL } });
    const { result } = renderHook(() => useRunCheck(MIDJOURNEY, { params: {} }, 1, PROJECT), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.creditText).toBe('Studio key'));
    expect(result.current.creditDetail).toBe('Uses the Studio\'s key, no credits');
  });

  it('says the description of an element takes credits when the language model runs on our keys', async () => {
    serve({ payer: 'self', llm: { usesAccountKey: false }, models: { describing: ON_WAVESPEED } });
    const { result } = renderHook(() => useRunCheck(DESCRIBING, WITH_ELEMENT, 1, PROJECT), { wrapper: wrapper() });

    // The line says credits are taken too, behind the credits star, so a charged run never reads like one that takes none.
    await waitFor(() => expect(result.current.creditText).toBe('Your key'));
    expect(result.current.creditAlso).toBe('credits');
    expect(result.current.creditDetail).toBe('Uses your key; describing elements takes credits');
  });

  it('says the same of the Studio’s key when the key is the admin’s', async () => {
    serve({ payer: 'admin', llm: { usesAccountKey: false }, models: { describing: ON_WAVESPEED } });
    const { result } = renderHook(() => useRunCheck(DESCRIBING, WITH_ELEMENT, 1, PROJECT), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.creditText).toBe('Studio key'));
    expect(result.current.creditAlso).toBe('credits');
    expect(result.current.creditDetail).toBe('Uses the Studio\'s key; describing elements takes credits');
  });

  it('takes no credits when the payer’s OpenRouter key runs the description, or the run has no element', async () => {
    serve({ payer: 'self', llm: { usesAccountKey: true }, models: { describing: ON_WAVESPEED } });
    const onPayerLlm = renderHook(() => useRunCheck(DESCRIBING, WITH_ELEMENT, 1, PROJECT), { wrapper: wrapper() });
    await waitFor(() => expect(onPayerLlm.result.current.creditText).toBe('Your key'));
    expect(onPayerLlm.result.current.creditDetail).toBe('Uses your key, no credits');

    serve({ payer: 'self', llm: { usesAccountKey: false }, models: { describing: ON_WAVESPEED } });
    const noElement = renderHook(() => useRunCheck(DESCRIBING, { params: {} }, 1, PROJECT), { wrapper: wrapper() });
    await waitFor(() => expect(noElement.result.current.creditText).toBe('Your key'));
    expect(noElement.result.current.creditDetail).toBe('Uses your key, no credits');
  });

  it('judges refusals on the payer’s upstream with the plan’s availability, even where the deployment has no key for it', async () => {
    serve({ payer: 'self', llm: { usesAccountKey: false }, models: { midjourney: ON_FAL } });
    const { result } = renderHook(() => useRunCheck(MIDJOURNEY, { params: {}, prompt: 'abcdef' }, 1, PROJECT), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.refusalText).toBeDefined());
  });

  it('judges refusals on the deployment’s weights when the model is not on the payer’s key', async () => {
    serve({ payer: 'self', llm: { usesAccountKey: false }, models: {} });
    const { result } = renderHook(() => useRunCheck(MIDJOURNEY, { params: {}, prompt: 'abcdef' }, 1, PROJECT), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.creditText).toBe('15'));
    expect(result.current.refusalText).toBeUndefined();
  });
});
