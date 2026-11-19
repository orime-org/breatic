// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How an external agent is named where members see it (#1488 design 19.2):
 * "connection name · owner name", with what tells same-named connections of
 * one owner apart.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectAgent } from '@web/data/yjs/project-meta';
import { useAgentLabels } from '@web/features/agent-presence/use-agent-labels';

const api = vi.hoisted(() => ({ connectionNames: vi.fn() }));
vi.mock('@web/data/api/agent-access', async (real) => ({
  ...(await real<typeof import('@web/data/api/agent-access')>()),
  agentAccessApi: api,
}));

/**
 * An agent's presence.
 * @param connectionId - Its connection.
 * @returns It.
 */
const agent = (connectionId: string): ProjectAgent => ({
  ownerId: 'u1', connectionId, online: true, idle: false, lastSeenAt: 1, spaceId: null, focus: [],
});

/**
 * A query client around the hook.
 * @param root0 - Props.
 * @param root0.children - The hook's host.
 * @returns It.
 */
function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  api.connectionNames.mockReset();
});

describe('useAgentLabels', () => {
  it('names an agent after its connection and its owner', async () => {
    api.connectionNames.mockResolvedValue([{ id: 'c1', name: 'Claude Code', tellApart: null }]);
    const agents = [agent('c1')];
    const { result } = renderHook(() => useAgentLabels(agents, new Map([['u1', 'Mika']])), { wrapper });
    await waitFor(() => expect(result.current.get('c1')).toBe('Claude Code · Mika'));
  });

  it('adds what tells an owner\'s same-named connections apart', async () => {
    api.connectionNames.mockResolvedValue([
      { id: 'c1', name: 'Claude Code', tellApart: { kind: 'token', prefix: 'brt_7f3a' } },
      { id: 'c2', name: 'Claude Code', tellApart: { kind: 'since', at: '2026-11-03T08:00:00.000Z' } },
    ]);
    const agents = [agent('c1'), agent('c2')];
    const { result } = renderHook(() => useAgentLabels(agents, new Map([['u1', 'Mika']])), { wrapper });
    await waitFor(() => expect(result.current.get('c1')).toBe('Claude Code (Token brt_7f3a) · Mika'));
    expect(result.current.get('c2')).toMatch(/^Claude Code \(Connected .+\) · Mika$/);
  });

  it('says "External agent" until the name arrives, and leaves out an owner it cannot name', () => {
    api.connectionNames.mockReturnValue(new Promise(() => undefined));
    const agents = [agent('c1')];
    const { result } = renderHook(() => useAgentLabels(agents, new Map()), { wrapper });
    expect(result.current.get('c1')).toBe('External agent');
  });
});
