// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The BYOK settings dialog (inner#1953): the account's own upstream keys, and which keyed upstream each non-language
 * model runs on.
 *
 * The dialog talks to the server only through the request helpers in `@web/data/api/request`, which this file
 * replaces, so what it pins is the HTTP contract (paths relative to the API base, methods, bodies) and what the user
 * sees, not the name of the api module in between.
 *
 * Contract this file assumes. The view's `enabled`, `keys`, `models` and `choices` follow the server's route tests
 * (`packages/server/src/__tests__/integration/byok-account-routes.integration.test.ts`); `upstreams` (the deployment's
 * list, from `config/provider/upstreams.yaml`) is this file's addition, since the dialog cannot name or group an upstream
 * without it. Model names, modalities and every upstream a model is bound to come from the catalog the panels already
 * read (`GET /models`).
 *
 *   GET    /account/byok                                       -> ByokView
 *   PUT    /account/byok/keys/:upstream   {key}                -> the saved key (422 with a localized message when it does not connect)
 *   POST   /account/byok/keys/:upstream/check                  -> the checked key
 *   DELETE /account/byok/keys/:upstream
 *   PUT    /account/byok/models/:model    {upstream: string | null}
 *
 * The dialog shows what a write did by reading the view again.
 *
 * Never a full key in any answer: a saved key is only ever shown by its `displayHint`.
 */

import type * as requestModule from '@web/data/api/request';
import type * as toastModule from '@web/lib/toast';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { api, toasts } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof requestModule>()),
  apiGet: api.get,
  apiPost: api.post,
  apiPut: api.put,
  apiDelete: api.delete,
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof toastModule>();
  return { ...actual, toast: { ...actual.toast, ...toasts } };
});

import { ByokDialog } from '@web/features/byok/ByokDialog';
import { ApiException } from '@web/data/api/types';

/** One upstream the deployment lists. */
interface Upstream {
  upstream: string;
  name: string;
  kind: 'llm' | 'official' | 'reseller';
  keyUrl: string | null;
}

/** One saved key, as the server answers it: never the key itself. */
interface SavedKey {
  upstream: string;
  displayHint: string;
  lastConnected: boolean;
  lastCheckedAt: string;
  lastBalanceState: 'known' | 'forbidden' | 'no_cap' | 'unsupported' | null;
  lastBalanceAmount: string | null;
  lastBalanceCurrency: string | null;
  lastFailure: string | null;
  /** Whether the key can read the actual costs of its calls; null where the upstream has no such probe. */
  costsReadable: boolean | null;
}

/** What `GET /account/byok` answers. */
interface ByokView {
  enabled: boolean;
  upstreams: Upstream[];
  keys: SavedKey[];
  /** The upstream each model is pointed at; a model left out runs on the platform key. */
  models: { model: string; upstream: string }[];
  /** For each media model, the upstreams holding a key of this account that can run it. */
  choices: Record<string, string[]>;
}

const UPSTREAMS: Upstream[] = [
  { upstream: 'openrouter', name: 'OpenRouter', kind: 'llm', keyUrl: 'https://openrouter.ai/settings/keys' },
  { upstream: 'google', name: 'Google', kind: 'official', keyUrl: 'https://aistudio.google.com/apikey' },
  { upstream: 'wavespeed', name: 'WaveSpeed', kind: 'reseller', keyUrl: 'https://wavespeed.ai/accesskey' },
  { upstream: 'fal', name: 'fal', kind: 'reseller', keyUrl: 'https://fal.ai/dashboard/keys' },
  { upstream: 'sandbase', name: 'SandBase', kind: 'reseller', keyUrl: 'https://sandbase.example/keys' },
];

const WAVESPEED_KEY: SavedKey = {
  upstream: 'wavespeed',
  displayHint: 'wsk_3f…9d0e',
  lastConnected: true,
  lastCheckedAt: '2026-11-17T02:00:00.000Z',
  lastBalanceState: 'known',
  lastBalanceAmount: '50.25',
  lastBalanceCurrency: 'USD',
  lastFailure: null,
  costsReadable: null,
};

const FAL_KEY: SavedKey = {
  upstream: 'fal',
  displayHint: '8c1e2a…7f3b',
  lastConnected: false,
  lastCheckedAt: '2026-11-17T03:00:00.000Z',
  lastBalanceState: null,
  lastBalanceAmount: null,
  lastBalanceCurrency: null,
  lastFailure: 'invalid',
  costsReadable: null,
};

/** What each media model's choices are with the WaveSpeed and fal keys saved. */
const CHOICES: Record<string, string[]> = {
  'seedream-5': ['wavespeed', 'fal'],
  'nano-banana-pro': ['wavespeed'],
  // Only upstreams without a key run it: it has no choice to make, so it is not listed.
  'imagen-4-ultra': [],
  'veo-3-1': ['fal'],
};

/**
 * One catalog entry, as `GET /models` carries it.
 * @param name - The model's id.
 * @param displayName - Its name on screen.
 * @param modality - Its catalog bucket.
 * @param upstreams - Every upstream it is bound to.
 * @returns The entry.
 */
function entry(name: string, displayName: string, modality: string, upstreams: string[]): Record<string, unknown> {
  return {
    name,
    display_name: displayName,
    modality,
    mode: 'generate',
    takes_prompt: true,
    params: {},
    availability: { upstreams: upstreams.map((upstream, weight) => ({ upstream, weight, configured: true, envVar: `${upstream.toUpperCase()}_KEY` })) },
  };
}

const CATALOG = {
  image: [
    entry('seedream-5', 'Seedream 5.0', 'image', ['wavespeed', 'fal']),
    entry('nano-banana-pro', 'Nano Banana Pro', 'image', ['google', 'wavespeed']),
    entry('imagen-4-ultra', 'Imagen 4 Ultra', 'image', ['google', 'sandbase']),
  ],
  video: [entry('veo-3-1', 'Veo 3.1', 'video', ['google', 'fal'])],
  audio: [],
  tts: [],
  three_d: [],
  total: 4,
  credit_multiplier: 1,
};

/** Two versions of one model under the same vendor name, told apart by their variant, both on WaveSpeed. */
const TWIN_CATALOG = {
  ...CATALOG,
  image: [
    { ...entry('gemini-pro-text', 'Gemini 3 Pro', 'image', ['wavespeed']), variant: 'Text' },
    { ...entry('gemini-pro-reference', 'Gemini 3 Pro', 'image', ['wavespeed']), variant: 'Reference' },
  ],
  video: [],
  total: 2,
};

/** The account's view over the twin catalog: a WaveSpeed key, both twins set to it. */
const TWIN_VIEW: Partial<ByokView> = {
  keys: [WAVESPEED_KEY],
  models: [{ model: 'gemini-pro-text', upstream: 'wavespeed' }, { model: 'gemini-pro-reference', upstream: 'wavespeed' }],
  choices: { 'gemini-pro-text': ['wavespeed'], 'gemini-pro-reference': ['wavespeed'] },
};

/**
 * The account's view.
 * @param over - Fields to override.
 * @returns The view.
 */
function view(over: Partial<ByokView> = {}): ByokView {
  return {
    enabled: true,
    upstreams: UPSTREAMS,
    keys: [WAVESPEED_KEY, FAL_KEY],
    models: [{ model: 'seedream-5', upstream: 'wavespeed' }, { model: 'veo-3-1', upstream: 'fal' }],
    choices: CHOICES,
    ...over,
  };
}

/** An account with no key at all. */
const EMPTY: Partial<ByokView> = { keys: [], models: [], choices: {} };

/**
 * Make the reads answer one view, now and on every re-read, beside the model catalog.
 * @param answer - The view.
 * @param catalog - The model catalog.
 */
function serve(answer: ByokView, catalog: object = CATALOG): void {
  api.get.mockImplementation((url: string) => {
    if (url === '/account/byok') return Promise.resolve(answer);
    if (url === '/models') return Promise.resolve(catalog);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

/**
 * A key the server refused because it does not connect.
 * @param message - The server's localized reason.
 * @returns The exception.
 */
function refused(message: string, reason = 'key_check_failed'): ApiException {
  return new ApiException({ status: 422, message, fromServer: true, reason });
}

/**
 * Each call's leading arguments: the path and, for a write, the body. Axios options after them are the
 * implementation's business.
 * @param fn - The replaced request helper.
 * @param count - How many leading arguments to keep.
 * @returns One array per call.
 */
function leading(fn: { mock: { calls: unknown[][] } }, count: number): unknown[][] {
  return fn.mock.calls.map((call) => call.slice(0, count));
}

/**
 * Render the open dialog.
 * @returns The dialog element.
 */
async function mount(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ByokDialog open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );
  return screen.findByRole('dialog', { name: 'BYOK settings' });
}

/**
 * The upstream rows of the left list, top to bottom, by upstream id.
 * @param dialog - The BYOK dialog.
 * @returns The ids.
 */
function rowOrder(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll('[data-testid^="byok-upstream-"]')].map((row) =>
    (row.getAttribute('data-testid') ?? '').replace('byok-upstream-', ''),
  );
}

/**
 * Switch to the models tab.
 * @param user - The userEvent session.
 * @param dialog - The BYOK dialog.
 */
async function openModels(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement): Promise<void> {
  await user.click(within(dialog).getByRole('tab', { name: 'Models' }));
}

/**
 * The options a model row's select offers, in order.
 * @param user - The userEvent session.
 * @param model - The model's name.
 * @returns The option labels.
 */
async function optionsOf(user: ReturnType<typeof userEvent.setup>, model: string): Promise<string[]> {
  await user.click(within(screen.getByTestId(`byok-model-${model}`)).getByRole('combobox'));
  const listbox = await screen.findByRole('listbox');
  return within(listbox).getAllByRole('option').map((option) => (option.textContent ?? '').trim());
}

describe('ByokDialog', () => {
  beforeEach(() => {
    for (const fn of [...Object.values(api), ...Object.values(toasts)]) fn.mockReset();
    serve(view());
  });

  it('is titled BYOK settings and has an upstream keys tab and a models tab', async () => {
    const dialog = await mount();
    const tabs = within(dialog).getAllByRole('tab').map((tab) => tab.textContent?.trim());
    expect(tabs.slice(0, 2)).toEqual(['Upstream keys', 'Models']);
    expect(within(dialog).getByRole('tab', { name: 'Upstream keys' })).toHaveAttribute('aria-selected', 'true');
    expect(leading(api.get, 1)).toContainEqual(['/account/byok']);
  });

  it('says so, and offers nothing, where the deployment has no master key', async () => {
    serve(view({ enabled: false, ...EMPTY }));
    const dialog = await mount();
    expect(await within(dialog).findByText('Bring your own key is not turned on for this deployment.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('tab')).toBeNull();
  });

  it('says the settings did not load, and offers a retry, when the model list fails to load', async () => {
    const user = userEvent.setup();
    let fail = true;
    api.get.mockImplementation((url: string) => {
      if (url === '/account/byok') return Promise.resolve(view());
      if (url === '/models') return fail ? Promise.reject(new Error('network')) : Promise.resolve(CATALOG);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    const dialog = await mount();

    expect(await within(dialog).findByText('Couldn\'t load BYOK settings.')).toBeInTheDocument();
    expect(within(dialog).queryByText('No model here runs on it.')).toBeNull();
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByTestId('byok-upstream-wavespeed')).toBeInTheDocument();
  });

  describe('upstream keys tab', () => {
    it('lists added upstreams first, then the rest by language model, official API and reseller', async () => {
      const dialog = await mount();
      await waitFor(() => expect(rowOrder(dialog)).toEqual(['wavespeed', 'fal', 'openrouter', 'google', 'sandbase']));

      const text = dialog.textContent ?? '';
      const at = (word: string): number => text.indexOf(word);
      expect(at('Added')).toBeGreaterThanOrEqual(0);
      expect(at('Language model')).toBeGreaterThan(at('Added'));
      expect(at('Official API')).toBeGreaterThan(at('Language model'));
      expect(at('Reseller')).toBeGreaterThan(at('Official API'));
    });

    it('marks each added upstream with a status dot, green when connected and red when not', async () => {
      const dialog = await mount();
      const wavespeed = await within(dialog).findByTestId('byok-upstream-wavespeed');
      const fal = within(dialog).getByTestId('byok-upstream-fal');
      expect(within(wavespeed).getByTestId('byok-status-dot')).toHaveAttribute('data-state', 'connected');
      expect(within(fal).getByTestId('byok-status-dot')).toHaveAttribute('data-state', 'failed');
      expect(within(within(dialog).getByTestId('byok-upstream-sandbase')).queryByTestId('byok-status-dot')).toBeNull();
    });

    it('says none are added yet when the account has no key', async () => {
      serve(view(EMPTY));
      const dialog = await mount();
      expect(await within(dialog).findByText('None added yet')).toBeInTheDocument();
    });

    it('filters the list as the user types in the search box', async () => {
      const user = userEvent.setup();
      const dialog = await mount();
      await within(dialog).findByTestId('byok-upstream-wavespeed');

      await user.type(within(dialog).getByPlaceholderText('Search upstreams'), 'sand');

      expect(rowOrder(dialog)).toEqual(['sandbase']);
    });

    it('hides the line under the added group when the search hides that group', async () => {
      const user = userEvent.setup();
      serve(view(EMPTY));
      const dialog = await mount();
      await within(dialog).findByTestId('byok-upstream-wavespeed');
      expect(within(dialog).getByTestId('byok-list-separator')).toBeInTheDocument();

      await user.type(within(dialog).getByPlaceholderText('Search upstreams'), 'wave');

      expect(rowOrder(dialog)).toEqual(['wavespeed']);
      expect(within(dialog).queryByTestId('byok-list-separator')).toBeNull();
    });

    it('moves the right pane to the first upstream the search leaves, and empties it when none is left', async () => {
      const user = userEvent.setup();
      serve(view(EMPTY));
      const dialog = await mount();
      await within(dialog).findByTestId('byok-detail-openrouter');
      const search = within(dialog).getByPlaceholderText('Search upstreams');

      await user.type(search, 'wave');
      expect(within(dialog).getByTestId('byok-detail-wavespeed')).toBeInTheDocument();
      expect(within(dialog).queryByTestId('byok-detail-openrouter')).toBeNull();

      await user.type(search, 'zz');
      expect(within(dialog).queryByTestId(/^byok-detail-/)).toBeNull();
    });

    it('says an OpenRouter key covers every language model, web animation included', async () => {
      const user = userEvent.setup();
      const dialog = await mount();
      await user.click(await within(dialog).findByTestId('byok-upstream-openrouter'));

      expect(within(dialog).getByTestId('byok-detail-openrouter')).toHaveTextContent(/every language model.*web animation/i);
    });

    it('names the models an upstream runs the way the generation panel does, a shared name joined by its variant', async () => {
      serve(view(TWIN_VIEW), TWIN_CATALOG);
      const dialog = await mount();
      const detail = await within(dialog).findByTestId('byok-detail-wavespeed');

      expect(within(detail).getByText('Gemini 3 Pro Text')).toBeInTheDocument();
      expect(within(detail).getByText('Gemini 3 Pro Reference')).toBeInTheDocument();
    });

    it('opens on the first added upstream, showing its hint, status, balance and where to get a key', async () => {
      const dialog = await mount();
      const detail = await within(dialog).findByTestId('byok-detail-wavespeed');
      expect(detail).toHaveTextContent('wsk_3f…9d0e');
      expect(detail).toHaveTextContent('Connected');
      expect(detail).toHaveTextContent('50.25');
      expect(within(detail).getByRole('link', { name: 'Get a key from WaveSpeed' })).toHaveAttribute(
        'href',
        'https://wavespeed.ai/accesskey',
      );
    });

    it('shows why a key that did not connect failed', async () => {
      const user = userEvent.setup();
      const dialog = await mount();
      await user.click(await within(dialog).findByTestId('byok-upstream-fal'));

      const detail = within(dialog).getByTestId('byok-detail-fal');
      expect(detail).toHaveTextContent('8c1e2a…7f3b');
      expect(detail).toHaveTextContent('Not connected');
      expect(detail).toHaveTextContent('The key is invalid or has been revoked.');
    });

    it.each([
      ['unavailable', 'Couldn\'t reach the upstream. Try again later.'],
      ['rate_limited', 'The upstream is limiting this key right now. Try again later.'],
      ['refused', 'The upstream refused the check.'],
    ])('says a check that failed as %s in its own words, not as a bad key', async (failure, sentence) => {
      const user = userEvent.setup();
      serve(view({ keys: [WAVESPEED_KEY, { ...FAL_KEY, lastFailure: failure }] }));
      const dialog = await mount();
      await user.click(await within(dialog).findByTestId('byok-upstream-fal'));

      expect(within(dialog).getByTestId('byok-detail-fal')).toHaveTextContent(sentence);
    });

    it('shows a balance as money in its own currency', async () => {
      serve(view({ keys: [{ ...WAVESPEED_KEY, lastBalanceAmount: '12', lastBalanceCurrency: 'EUR' }, FAL_KEY] }));
      const dialog = await mount();

      expect(await within(dialog).findByTestId('byok-detail-wavespeed')).toHaveTextContent('€12.00');
    });

    it('says a key that cannot read actual costs cannot, and says nothing of it otherwise', async () => {
      const user = userEvent.setup();
      serve(view({ keys: [WAVESPEED_KEY, { ...FAL_KEY, lastConnected: true, lastFailure: null, lastBalanceState: 'forbidden', costsReadable: false }] }));
      const dialog = await mount();
      const wavespeed = await within(dialog).findByTestId('byok-detail-wavespeed');
      expect(wavespeed).not.toHaveTextContent('This key cannot read actual costs.');

      await user.click(within(dialog).getByTestId('byok-upstream-fal'));

      expect(within(dialog).getByTestId('byok-detail-fal')).toHaveTextContent('This key cannot read actual costs.');
    });

    it('checks the saved key again on refresh, with the button waiting on the request', async () => {
      let answer: (next: SavedKey) => void = () => undefined;
      api.post.mockReturnValue(new Promise<SavedKey>((resolve) => { answer = resolve; }));
      const user = userEvent.setup();
      const dialog = await mount();
      const detail = await within(dialog).findByTestId('byok-detail-wavespeed');

      await user.click(within(detail).getByRole('button', { name: 'Refresh' }));

      expect(leading(api.post, 1)).toEqual([['/account/byok/keys/wavespeed/check']]);
      expect(within(detail).getByRole('button', { name: 'Refresh' })).toHaveAttribute('aria-busy', 'true');

      const fresh: SavedKey = { ...WAVESPEED_KEY, lastBalanceAmount: '12.00', lastCheckedAt: '2026-11-17T05:00:00.000Z' };
      const checked = view({ keys: [fresh, FAL_KEY] });
      serve(checked);
      answer(fresh);
      await waitFor(() => expect(within(dialog).getByTestId('byok-detail-wavespeed')).toHaveTextContent('12.00'));
      expect(within(dialog).getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-busy', 'true');
    });

    it('adds a key for an upstream not yet added, and moves it to the added group', async () => {
      const user = userEvent.setup();
      const sandbase: SavedKey = { ...WAVESPEED_KEY, upstream: 'sandbase', displayHint: 'sb-sec…3456', lastBalanceAmount: '42.13' };
      api.put.mockImplementation(() => {
        serve(view({ keys: [WAVESPEED_KEY, FAL_KEY, sandbase] }));
        return Promise.resolve(sandbase);
      });
      const dialog = await mount();
      await user.click(await within(dialog).findByTestId('byok-upstream-sandbase'));
      const detail = within(dialog).getByTestId('byok-detail-sandbase');

      await user.type(within(detail).getByLabelText('API key'), 'sb-secret-123456');
      await user.click(within(detail).getByRole('button', { name: 'Save' }));

      expect(leading(api.put, 2)).toEqual([['/account/byok/keys/sandbase', { key: 'sb-secret-123456' }]]);
      await waitFor(() => expect(rowOrder(dialog).slice(0, 3)).toEqual(['wavespeed', 'fal', 'sandbase']));
      const after = within(dialog).getByTestId('byok-detail-sandbase');
      expect(after).toHaveTextContent('sb-sec…3456');
      expect(dialog.textContent).not.toContain('sb-secret-123456');
    });

    it('says why the upstream refused a key it could not check, in the words a saved key gets', async () => {
      const user = userEvent.setup();
      api.put.mockRejectedValue(refused('This key could not connect. Check it and try again.', 'unavailable'));
      const dialog = await mount();
      await user.click(await within(dialog).findByTestId('byok-upstream-sandbase'));
      const detail = within(dialog).getByTestId('byok-detail-sandbase');

      await user.type(within(detail).getByLabelText('API key'), 'sb-maybe');
      await user.click(within(detail).getByRole('button', { name: 'Save' }));

      expect(await within(detail).findByText('Couldn\'t reach the upstream. Try again later.')).toBeInTheDocument();
    });

    it('keeps a save waiting, and its refusal, across switching to another upstream and back', async () => {
      let reject: (err: unknown) => void = () => undefined;
      api.put.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
      const user = userEvent.setup();
      const dialog = await mount();
      await user.click(await within(dialog).findByTestId('byok-upstream-sandbase'));
      await user.type(within(within(dialog).getByTestId('byok-detail-sandbase')).getByLabelText('API key'), 'sb-wrong');
      await user.click(within(within(dialog).getByTestId('byok-detail-sandbase')).getByRole('button', { name: 'Save' }));

      await user.click(within(dialog).getByTestId('byok-upstream-wavespeed'));
      await user.click(within(dialog).getByTestId('byok-upstream-sandbase'));
      expect(within(within(dialog).getByTestId('byok-detail-sandbase')).getByRole('button', { name: 'Save' })).toHaveAttribute('aria-busy', 'true');

      await user.click(within(dialog).getByTestId('byok-upstream-wavespeed'));
      reject(refused('Could not connect: the key is invalid.'));
      await user.click(within(dialog).getByTestId('byok-upstream-sandbase'));
      expect(await within(within(dialog).getByTestId('byok-detail-sandbase')).findByText('Could not connect: the key is invalid.')).toBeInTheDocument();
    });

    it('keeps a key that does not connect unsaved, with the reason under the input', async () => {
      const user = userEvent.setup();
      api.put.mockRejectedValue(refused('Could not connect: the key is invalid.'));
      const dialog = await mount();
      await user.click(await within(dialog).findByTestId('byok-upstream-sandbase'));
      const detail = within(dialog).getByTestId('byok-detail-sandbase');

      await user.type(within(detail).getByLabelText('API key'), 'sb-wrong');
      await user.click(within(detail).getByRole('button', { name: 'Save' }));

      expect(await within(detail).findByText('Could not connect: the key is invalid.')).toBeInTheDocument();
      expect(within(detail).getByLabelText('API key')).toHaveAttribute('aria-invalid', 'true');
      expect(rowOrder(dialog).indexOf('sandbase')).toBeGreaterThan(rowOrder(dialog).indexOf('google'));
    });

    describe('replacing a key', () => {
      /**
       * Open the replace dialog for WaveSpeed.
       * @param user - The userEvent session.
       * @returns The replace dialog.
       */
      async function openReplace(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
        const dialog = await mount();
        const detail = await within(dialog).findByTestId('byok-detail-wavespeed');
        await user.click(within(detail).getByRole('button', { name: 'Replace' }));
        return screen.findByRole('dialog', { name: 'Replace the WaveSpeed key' });
      }

      it('says tasks using the old key may be interrupted or fail, and to revoke a leaked key at the upstream', async () => {
        const user = userEvent.setup();
        const replace = await openReplace(user);
        expect(replace).toHaveTextContent(/tasks using the old key may be interrupted or fail/i);
        expect(replace).toHaveTextContent(/if the old key has leaked, also revoke it at WaveSpeed/i);
      });

      it('saves the new key and closes', async () => {
        const user = userEvent.setup();
        const replaced: SavedKey = { ...WAVESPEED_KEY, displayHint: 'wsk_new…beef' };
        api.put.mockImplementation(() => {
          serve(view({ keys: [replaced, FAL_KEY] }));
          return Promise.resolve(replaced);
        });
        const replace = await openReplace(user);

        await user.type(within(replace).getByLabelText('API key'), 'wsk_new_key_beef');
        await user.click(within(replace).getByRole('button', { name: 'Save' }));

        expect(leading(api.put, 2)).toEqual([['/account/byok/keys/wavespeed', { key: 'wsk_new_key_beef' }]]);
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace the WaveSpeed key' })).toBeNull());
        expect(await screen.findByTestId('byok-detail-wavespeed')).toHaveTextContent('wsk_new…beef');
      });

      it('keeps the old key and the dialog open, with the reason inline, when the new key does not connect', async () => {
        const user = userEvent.setup();
        api.put.mockRejectedValue(refused('Could not connect: the key is invalid.'));
        const replace = await openReplace(user);

        await user.type(within(replace).getByLabelText('API key'), 'wsk_bad');
        await user.click(within(replace).getByRole('button', { name: 'Save' }));

        expect(await within(replace).findByText('Could not connect: the key is invalid.')).toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Replace the WaveSpeed key' })).toBeInTheDocument();
        expect(screen.getByTestId('byok-detail-wavespeed')).toHaveTextContent('wsk_3f…9d0e');
      });

      it('keeps the replace dialog open, waiting, until the settings are read again after a save', async () => {
        const user = userEvent.setup();
        const replaced: SavedKey = { ...WAVESPEED_KEY, displayHint: 'wsk_new…beef' };
        let release: () => void = () => undefined;
        api.put.mockImplementation(() => {
          api.get.mockImplementation((url: string) => {
            if (url === '/models') return Promise.resolve(CATALOG);
            return new Promise((done) => {
              release = () => done(view({ keys: [replaced, FAL_KEY] }));
            });
          });
          return Promise.resolve(replaced);
        });
        const replace = await openReplace(user);
        await user.type(within(replace).getByLabelText('API key'), 'wsk_new_key_beef');
        await user.click(within(replace).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(api.put).toHaveBeenCalled());
        expect(screen.getByRole('dialog', { name: 'Replace the WaveSpeed key' })).toBeInTheDocument();
        expect(toasts.success).not.toHaveBeenCalled();
        release();
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace the WaveSpeed key' })).toBeNull());
        expect(screen.getByTestId('byok-detail-wavespeed')).toHaveTextContent('wsk_new…beef');
      });

      it('opens again with an empty field and no refusal under it', async () => {
        const user = userEvent.setup();
        api.put.mockRejectedValue(refused('Could not connect: the key is invalid.'));
        const replace = await openReplace(user);
        await user.type(within(replace).getByLabelText('API key'), 'wsk_bad');
        await user.click(within(replace).getByRole('button', { name: 'Save' }));
        await within(replace).findByText('Could not connect: the key is invalid.');
        await user.click(within(replace).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace the WaveSpeed key' })).toBeNull());

        await user.click(within(screen.getByTestId('byok-detail-wavespeed')).getByRole('button', { name: 'Replace' }));
        const again = await screen.findByRole('dialog', { name: 'Replace the WaveSpeed key' });

        expect(within(again).queryByText('Could not connect: the key is invalid.')).toBeNull();
      });
    });

    it('opens the settings again with no refusal left from before they were closed', async () => {
      const user = userEvent.setup();
      api.put.mockRejectedValue(refused('Could not connect: the key is invalid.'));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const shown = (open: boolean): React.JSX.Element => (
        <QueryClientProvider client={client}>
          <ByokDialog open={open} onOpenChange={() => undefined} />
        </QueryClientProvider>
      );
      const { rerender } = render(shown(true));
      const dialog = await screen.findByRole('dialog', { name: 'BYOK settings' });
      await user.click(await within(dialog).findByTestId('byok-upstream-sandbase'));
      const detail = within(dialog).getByTestId('byok-detail-sandbase');
      await user.type(within(detail).getByPlaceholderText('Paste a key'), 'sb_bad');
      await user.click(within(detail).getByRole('button', { name: 'Save' }));
      await within(detail).findByText('Could not connect: the key is invalid.');

      rerender(shown(false));
      rerender(shown(true));
      const again = await screen.findByRole('dialog', { name: 'BYOK settings' });
      await user.click(await within(again).findByTestId('byok-upstream-sandbase'));

      expect(within(within(again).getByTestId('byok-detail-sandbase')).queryByText('Could not connect: the key is invalid.')).toBeNull();
    });

    describe('deleting a key', () => {
      it('reads the keys again after a delete that failed, so a key gone meanwhile leaves the list', async () => {
        const user = userEvent.setup();
        api.delete.mockImplementation(() => {
          serve(view({ keys: [WAVESPEED_KEY], models: [], choices: {} }));
          return Promise.reject(new Error('network'));
        });
        const dialog = await mount();
        await user.click(await within(dialog).findByTestId('byok-upstream-fal'));
        await user.click(within(within(dialog).getByTestId('byok-detail-fal')).getByRole('button', { name: 'Delete' }));
        await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(rowOrder(dialog).indexOf('fal')).toBeGreaterThan(rowOrder(dialog).indexOf('google')));
      });

      it('warns that tasks using it will be interrupted and lists the models that go back to the platform key', async () => {
        const user = userEvent.setup();
        const dialog = await mount();
        await user.click(await within(dialog).findByTestId('byok-upstream-fal'));
        await user.click(within(within(dialog).getByTestId('byok-detail-fal')).getByRole('button', { name: 'Delete' }));

        const confirm = await screen.findByRole('alertdialog');
        expect(confirm).toHaveTextContent(/tasks using this key may be interrupted or fail/i);
        expect(confirm).toHaveTextContent(/if the key has leaked, also revoke it at fal/i);
        expect(confirm).toHaveTextContent('Veo 3.1');
        expect(confirm).not.toHaveTextContent('Seedream 5.0');
        expect(api.delete).not.toHaveBeenCalled();
      });

      it('lists the models going back to the platform key by the names the generation panel gives them', async () => {
        const user = userEvent.setup();
        serve(view(TWIN_VIEW), TWIN_CATALOG);
        const dialog = await mount();
        const detail = await within(dialog).findByTestId('byok-detail-wavespeed');
        await user.click(within(detail).getByRole('button', { name: 'Delete' }));

        const confirm = await screen.findByRole('alertdialog');
        expect(within(confirm).getByText('Gemini 3 Pro Text')).toBeInTheDocument();
        expect(within(confirm).getByText('Gemini 3 Pro Reference')).toBeInTheDocument();
      });

      it('reads a key already gone as deleted, and the add form shows no refusal from an earlier replace', async () => {
        const user = userEvent.setup();
        api.put.mockRejectedValue(refused('Could not connect: the key is invalid.'));
        const dialog = await mount();
        const detail = await within(dialog).findByTestId('byok-detail-wavespeed');
        await user.click(within(detail).getByRole('button', { name: 'Replace' }));
        const replace = await screen.findByRole('dialog', { name: 'Replace the WaveSpeed key' });
        await user.type(within(replace).getByLabelText('API key'), 'wsk_bad');
        await user.click(within(replace).getByRole('button', { name: 'Save' }));
        await within(replace).findByText('Could not connect: the key is invalid.');
        await user.click(within(replace).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace the WaveSpeed key' })).toBeNull());
        // Another tab deleted the key meanwhile: this delete is answered 404.
        api.delete.mockImplementation(() => {
          serve(view({ keys: [FAL_KEY], models: [], choices: {} }));
          return Promise.reject(new ApiException({ status: 404, message: 'Not found', fromServer: true }));
        });

        await user.click(within(within(dialog).getByTestId('byok-detail-wavespeed')).getByRole('button', { name: 'Delete' }));
        await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(toasts.success).toHaveBeenCalled());
        expect(toasts.error).not.toHaveBeenCalled();
        await user.click(await within(dialog).findByTestId('byok-upstream-wavespeed'));
        const add = await within(dialog).findByTestId('byok-detail-wavespeed');
        await waitFor(() => expect(within(add).getByPlaceholderText('Paste a key')).toBeInTheDocument());
        expect(within(add).queryByText('Could not connect: the key is invalid.')).toBeNull();
      });

      it('deletes on confirm', async () => {
        const user = userEvent.setup();
        const deleted = view({
          keys: [WAVESPEED_KEY],
          models: [{ model: 'seedream-5', upstream: 'wavespeed' }],
          choices: { 'seedream-5': ['wavespeed'], 'nano-banana-pro': ['wavespeed'] },
        });
        api.delete.mockImplementation(() => {
          serve(deleted);
          return Promise.resolve(undefined);
        });
        const dialog = await mount();
        await user.click(await within(dialog).findByTestId('byok-upstream-fal'));
        await user.click(within(within(dialog).getByTestId('byok-detail-fal')).getByRole('button', { name: 'Delete' }));
        const confirm = await screen.findByRole('alertdialog');

        await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

        expect(leading(api.delete, 1)).toEqual([['/account/byok/keys/fal']]);
        await waitFor(() => expect(rowOrder(dialog)[0]).toBe('wavespeed'));
        await waitFor(() => expect(rowOrder(dialog).indexOf('fal')).toBeGreaterThan(rowOrder(dialog).indexOf('google')));
      });
    });
  });

  describe('models tab', () => {
    it('lists only models a keyed upstream can run, under modality tabs', async () => {
      const user = userEvent.setup();
      const dialog = await mount();
      await openModels(user, dialog);

      const image = await within(dialog).findByRole('tab', { name: /^Image/ });
      expect(image).toHaveAttribute('aria-selected', 'true');
      expect(image).toHaveTextContent('2');
      expect(within(dialog).getByTestId('byok-model-seedream-5')).toBeInTheDocument();
      expect(within(dialog).getByTestId('byok-model-nano-banana-pro')).toBeInTheDocument();
      expect(within(dialog).queryByTestId('byok-model-imagen-4-ultra')).toBeNull();
      expect(within(dialog).queryByTestId('byok-model-veo-3-1')).toBeNull();

      await user.click(within(dialog).getByRole('tab', { name: /^Video/ }));
      expect(await within(dialog).findByTestId('byok-model-veo-3-1')).toBeInTheDocument();
      expect(within(dialog).queryByTestId('byok-model-seedream-5')).toBeNull();
    });

    it('filters the models as the user types in the search box', async () => {
      const user = userEvent.setup();
      const dialog = await mount();
      await openModels(user, dialog);
      await within(dialog).findByTestId('byok-model-seedream-5');

      await user.type(within(dialog).getByPlaceholderText('Search models'), 'nano');

      expect(within(dialog).getByTestId('byok-model-nano-banana-pro')).toBeInTheDocument();
      expect(within(dialog).queryByTestId('byok-model-seedream-5')).toBeNull();
    });

    it('names each model the way the generation panel does, searches that name and says it when saved', async () => {
      const user = userEvent.setup();
      api.put.mockResolvedValue(undefined);
      serve(view(TWIN_VIEW), TWIN_CATALOG);
      const dialog = await mount();
      await openModels(user, dialog);
      expect(await within(dialog).findByTestId('byok-model-gemini-pro-text')).toHaveTextContent('Gemini 3 Pro Text');
      expect(within(dialog).getByTestId('byok-model-gemini-pro-reference')).toHaveTextContent('Gemini 3 Pro Reference');

      await user.type(within(dialog).getByPlaceholderText('Search models'), 'pro ref');
      expect(within(dialog).queryByTestId('byok-model-gemini-pro-text')).toBeNull();

      await optionsOf(user, 'gemini-pro-reference');
      await user.click(screen.getByRole('option', { name: 'Platform key (uses credits)' }));
      await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Gemini 3 Pro Reference now uses Platform key (uses credits)'));
    });

    it('defaults each model to the platform key and offers only keyed upstreams that run it', async () => {
      const user = userEvent.setup();
      const dialog = await mount();
      await openModels(user, dialog);
      const nano = await within(dialog).findByTestId('byok-model-nano-banana-pro');
      expect(within(nano).getByRole('combobox')).toHaveTextContent('Platform key (uses credits)');

      expect(await optionsOf(user, 'nano-banana-pro')).toEqual(['Platform key (uses credits)', 'WaveSpeed']);
    });

    it('shows the upstream a model is set to, among every keyed upstream that runs it', async () => {
      const user = userEvent.setup();
      const dialog = await mount();
      await openModels(user, dialog);
      const seedream = await within(dialog).findByTestId('byok-model-seedream-5');
      expect(within(seedream).getByRole('combobox')).toHaveTextContent('WaveSpeed');

      expect(await optionsOf(user, 'seedream-5')).toEqual(['Platform key (uses credits)', 'WaveSpeed', 'fal']);
    });

    it('saves the upstream the user picks for a model', async () => {
      const user = userEvent.setup();
      api.put.mockResolvedValue(undefined);
      const dialog = await mount();
      await openModels(user, dialog);
      await within(dialog).findByTestId('byok-model-nano-banana-pro');

      await optionsOf(user, 'nano-banana-pro');
      await user.click(screen.getByRole('option', { name: 'WaveSpeed' }));

      await waitFor(() =>
        expect(leading(api.put, 2)).toEqual([['/account/byok/models/nano-banana-pro', { upstream: 'wavespeed' }]]),
      );
    });

    it('clears the choice when the user picks the platform key back', async () => {
      const user = userEvent.setup();
      api.put.mockResolvedValue(undefined);
      const dialog = await mount();
      await openModels(user, dialog);
      await within(dialog).findByTestId('byok-model-seedream-5');

      await optionsOf(user, 'seedream-5');
      await user.click(screen.getByRole('option', { name: 'Platform key (uses credits)' }));

      await waitFor(() =>
        expect(leading(api.put, 2)).toEqual([['/account/byok/models/seedream-5', { upstream: null }]]),
      );
    });

    it('gives an OpenRouter key no per-model choice: it already covers every language model', async () => {
      const user = userEvent.setup();
      serve(view({
        ...EMPTY,
        keys: [{ ...WAVESPEED_KEY, upstream: 'openrouter', displayHint: 'sk-or-…a1B2', lastBalanceState: 'no_cap', lastBalanceAmount: null }],
      }));
      const dialog = await mount();
      await openModels(user, dialog);

      expect(await within(dialog).findByText(/Add an upstream key, then choose here/)).toBeInTheDocument();
      expect(within(dialog).queryByTestId(/^byok-model-/)).toBeNull();
    });

    it('points an account with no key back to the upstream keys tab', async () => {
      const user = userEvent.setup();
      serve(view(EMPTY));
      const dialog = await mount();
      await openModels(user, dialog);

      await user.click(await within(dialog).findByRole('button', { name: 'Add a key' }));

      expect(within(dialog).getByRole('tab', { name: 'Upstream keys' })).toHaveAttribute('aria-selected', 'true');
    });
  });
});
