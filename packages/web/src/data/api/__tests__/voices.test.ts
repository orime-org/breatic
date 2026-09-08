// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — the panel's side of `GET /models/:name/voices`.
 *
 * Two things are worth pinning here. The search term and the cursor are put
 * on the query string, where an unencoded `&` or `#` in what the user typed
 * would end the parameter early and search for something else. And every
 * response goes through `sanitizeVoicePage`, so a vendor page that arrives
 * malformed degrades instead of reaching the picker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { voicesApi } from '@web/data/api/voices';
import { apiGet } from '@web/data/api/request';

vi.mock('@web/data/api/request', () => ({ apiGet: vi.fn() }));

const mockGet = vi.mocked(apiGet);

describe('voicesApi.list (#1960 A2)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ voices: [], hasMore: false });
  });

  it('asks the endpoint for that model', async () => {
    await voicesApi.list('elevenlabs-v3', {});
    expect(mockGet).toHaveBeenCalledWith('/models/elevenlabs-v3/voices');
  });

  it('puts the search term on the query string, encoded', async () => {
    await voicesApi.list('fish-s2-pro', { query: 'deep & calm' });
    expect(mockGet).toHaveBeenCalledWith(
      '/models/fish-s2-pro/voices?query=deep+%26+calm',
    );
  });

  it('sends the cursor the last page handed back', async () => {
    await voicesApi.list('fish-s2-pro', { cursor: 'page/2' });
    expect(mockGet).toHaveBeenCalledWith(
      '/models/fish-s2-pro/voices?cursor=page%2F2',
    );
  });

  it('sends both together when paging through a search', async () => {
    await voicesApi.list('fish-s2-pro', { query: 'calm', cursor: '2' });
    expect(mockGet).toHaveBeenCalledWith(
      '/models/fish-s2-pro/voices?query=calm&cursor=2',
    );
  });

  it('leaves an empty search off the query string entirely', async () => {
    await voicesApi.list('fish-s2-pro', { query: '' });
    expect(mockGet).toHaveBeenCalledWith('/models/fish-s2-pro/voices');
  });

  it('encodes the model name into the path', async () => {
    await voicesApi.list('a model/b', {});
    expect(mockGet).toHaveBeenCalledWith('/models/a%20model%2Fb/voices');
  });

  it('sanitizes what comes back, so a bad page cannot reach the picker', async () => {
    mockGet.mockResolvedValue({
      voices: [{ id: 'x', name: 'X' }, { name: 'no id' }],
      hasMore: 'yes',
    });
    const page = await voicesApi.list('fish-s2-pro', {});
    expect(page).toEqual({ voices: [{ id: 'x', name: 'X' }], hasMore: false });
  });
});

describe('voicesApi.get (#1960, showing the chosen voice by name)', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('asks for one voice by its id', async () => {
    mockGet.mockResolvedValue({ id: 'abc', name: 'George' });
    const voice = await voicesApi.get('elevenlabs-v3', 'abc');
    expect(mockGet).toHaveBeenCalledWith('/models/elevenlabs-v3/voices/abc');
    expect(voice).toEqual({ id: 'abc', name: 'George' });
  });

  it('encodes an id that would otherwise change the path', async () => {
    mockGet.mockResolvedValue({ id: 'a/b', name: 'X' });
    await voicesApi.get('fish-s2-pro', 'a/b');
    expect(mockGet).toHaveBeenCalledWith('/models/fish-s2-pro/voices/a%2Fb');
  });

  it('answers null for a voice the page cannot use, rather than a half one', async () => {
    // Same rule as the list: no id means picking it would submit nothing, and
    // no name means there is nothing to show in the trigger.
    mockGet.mockResolvedValue({ id: 'abc' });
    await expect(voicesApi.get('elevenlabs-v3', 'abc')).resolves.toBeNull();
  });
});
