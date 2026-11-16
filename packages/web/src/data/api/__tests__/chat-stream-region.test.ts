// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A conversation's run is read from the region its Project lives in
 * (inner#1955): the run is written there, and the global region holds no
 * stream of another region's conversation.
 */

import { describe, expect, it, vi } from 'vitest';

const TWO_REGIONS = {
  global: 'us-west',
  regions: {
    'us-west': { api: 'https://us.example.test/api/v1', collab: 'wss://us.example.test/ws' },
    sg: { api: 'https://sg.example.test/api/v1', collab: 'wss://sg.example.test/ws' },
  },
};

vi.mock('@web/data/api/regions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/regions')>()),
  getRegionConfig: () => TWO_REGIONS,
}));

import { chatApi } from '@web/data/api/chat';
import { rememberProjectRegion } from '@web/data/api/regions';

describe('the stream of a conversation in a build with regions', () => {
  it('is read from the region of its Project', () => {
    rememberProjectRegion('p-sg', 'sg');
    expect(chatApi.streamPath('c1', 'p-sg')).toBe('https://sg.example.test/api/v1/chat/conversations/c1/stream');
  });
});
