// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A conversation's run is read from its Project's region only once the
 * identity token is fresh (inner#1955): the stream is not an axios request,
 * so a region's `identity_expired` would not be retried, and a tab that sat
 * hidden past the token's minute would have the read refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TWO_REGIONS = vi.hoisted(() => ({
  global: 'us-west',
  regions: {
    'us-west': { api: 'https://us.example.test/api/v1', collab: 'wss://us.example.test/ws' },
    sg: { api: 'https://sg.example.test/api/v1', collab: 'wss://sg.example.test/ws' },
  },
}));
vi.mock('@web/data/api/regions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/regions')>()),
  getRegionConfig: () => TWO_REGIONS,
}));
let freshen: () => void = () => undefined;
const ensureFreshIdentity = vi.hoisted(() => vi.fn());
vi.mock('@web/data/api/identity-renewal', () => ({ ensureFreshIdentity }));

const { chatSessionFor, evictAllChatSessions, readRun } = await import('@web/stores/chat-sessions');
const { rememberProjectRegion } = await import('@web/data/api/regions');

const OPENS_AND_ENDS = 'data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n';
const read: string[] = [];
const original = globalThis.fetch;

beforeEach(() => {
  evictAllChatSessions();
  read.length = 0;
  ensureFreshIdentity.mockImplementation(() => new Promise<void>((resolve) => {
    freshen = resolve;
  }));
  globalThis.fetch = ((url: string) => {
    read.push(String(url));
    return Promise.resolve(new Response(OPENS_AND_ENDS, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

describe('reading a run', () => {
  it('opens the stream at the Project region only after the token is fresh', async () => {
    rememberProjectRegion('p-sg', 'sg');
    chatSessionFor({ projectId: 'p-sg', conversationId: 'c-1', history: [], onTitled: () => undefined });

    const reading = readRun('c-1', () => undefined);
    await vi.waitFor(() => expect(ensureFreshIdentity).toHaveBeenCalled());
    expect(read).toEqual([]);
    freshen();
    await reading;
    expect(read).toEqual(['https://sg.example.test/api/v1/chat/conversations/c-1/stream']);
  });
});
