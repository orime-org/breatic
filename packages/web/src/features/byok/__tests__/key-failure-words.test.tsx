// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1953: a run on the payer's own key that failed says whose key it was and names the upstream as the user knows
 * it, wherever the failure is shown: a node's task list, its history and the Agent's reply. Whose key and the names come
 * from the Project's key plan, read once for the Project page.
 */

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { encodeTaskFailure, setLocale, type NodeTaskEntry } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import type { KeyPlan } from '@web/data/api/byok';
import type { NodeHistoryEntry } from '@web/data/api/canvas';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import { KeyFailureWordsProvider } from '@web/features/byok/key-failure-words';
import { TaskRow } from '@web/spaces/canvas/tasks/TaskRow';
import { NodeHistoryRow } from '@web/spaces/canvas/history/NodeHistoryRow';
import { TurnEnding } from '@web/pages/project/chat/TurnEnding';

const keyPlan = vi.fn<(projectId: string) => Promise<KeyPlan>>();
vi.mock('@web/data/api/byok', () => ({ byokApi: { keyPlan: (projectId: string) => keyPlan(projectId) } }));

/**
 * A key plan whose payer is given.
 * @param payer - Whose keys pay.
 * @returns The plan.
 */
function plan(payer: 'self' | 'admin'): KeyPlan {
  return { payer, llm: { usesAccountKey: true }, models: {}, upstreamNames: { wavespeed: 'WaveSpeed Cloud', openrouter: 'OpenRouter' } };
}

/**
 * Render inside the Project page's key plan.
 * @param ui - What to render.
 */
function renderInProject(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <KeyFailureWordsProvider projectId='p-1'>{ui}</KeyFailureWordsProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const NO_BALANCE = encodeTaskFailure('account_key_failed', { upstream: 'wavespeed', keyReason: 'no_balance' });

/**
 * A failed task.
 * @returns The entry.
 */
function failedTask(): NodeTaskEntry {
  return {
    id: 't-1', projectId: 'p-1', spaceId: 's-1', nodeId: 'n-1', kind: 'generation', action: 'generate', status: 'failed',
    startedByUserId: 'u-1', startedAt: '2026-11-17T00:00:00.000Z', settledAt: '2026-11-17T00:01:00.000Z', budgetMs: 60_000,
    label: 'Seedream', errorMessage: NO_BALANCE, nodeHistoryId: null, content: null, coverUrl: null, mediaWidth: null,
    mediaHeight: null, duration: null, mimeType: null, size: null,
  };
}

beforeEach(() => {
  setLocale('en');
  keyPlan.mockReset();
});
afterEach(cleanup);

describe('a failed run on an account key', () => {
  it('tells the payer on the task list that it is their own key, by the upstream name', async () => {
    keyPlan.mockResolvedValue(plan('self'));
    renderInProject(
      <CollaboratorNamesProvider value={{ resolve: () => 'Ada', members: [] }}>
        <TaskRow
          entry={failedTask()}
          now={Date.parse('2026-11-17T00:02:00.000Z')}
          hasRetryFile={false}
          readOnly={false}
          retrying={false}
          dismissing={false}
          onView={() => {}}
          onRetry={() => {}}
          onDismiss={() => {}}
        />
      </CollaboratorNamesProvider>,
    );

    expect(await screen.findByText('Your WaveSpeed Cloud key is out of balance. Top up at WaveSpeed Cloud.')).toBeInTheDocument();
    expect(keyPlan).toHaveBeenCalledWith('p-1');
  });

  it('tells a member in the node history that it is the Studio Admin\'s key', async () => {
    keyPlan.mockResolvedValue(plan('admin'));
    const entry: NodeHistoryEntry = {
      id: 'h1', operatorName: null, entryType: 'generation', status: 'failed', content: null, thumbnailUrl: null,
      errorMessage: NO_BALANCE, metadata: {}, mediaWidth: null, mediaHeight: null, duration: null, mimeType: null,
      size: null, createdAt: '2026-11-17T00:00:00.000Z',
    };
    renderInProject(<NodeHistoryRow entry={entry} modality='image' isCurrent={false} isFocused={false} onRestore={() => {}} />);

    expect(
      await screen.findByText('The Studio Admin\'s WaveSpeed Cloud key is out of balance. Ask the Studio Admin to top up at WaveSpeed Cloud.'),
    ).toBeInTheDocument();
  });

  it('says in the Agent\'s reply which key failed instead of a bare failure', async () => {
    keyPlan.mockResolvedValue(plan('admin'));
    renderInProject(
      <TurnEnding
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          failed: true,
          keyFailure: { reason: 'account_key_failed', upstream: 'openrouter', keyReason: 'invalid' },
        }}
      />,
    );

    expect(
      await screen.findByText('OpenRouter turned down the Studio Admin\'s key as invalid. Ask the Studio Admin to change it.'),
    ).toBeInTheDocument();
  });
});
