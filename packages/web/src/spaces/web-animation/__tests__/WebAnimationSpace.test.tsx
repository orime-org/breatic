// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space as users meet it (#1490 design §7): no top bar, the preview filling the Space, and one floating
 * bottom bar of icon buttons with play first and the Executions, Annotations and New group last. The two panels open
 * one at a time, docked inside the Space; a Viewer sees no New. With no result the preview offers New; otherwise it
 * opens the newest finished result.
 */

import * as React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { _resetForTests } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';
import { WebAnimationSpace } from '@web/spaces/web-animation/WebAnimationSpace';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return {
    ...actual,
    timelineApi: { ...actual.timelineApi, listSpaceExecutions: vi.fn(), getExecution: vi.fn(), previewUrl: vi.fn(), limits: vi.fn() },
  };
});
vi.mock('@hyperframes/player', () => ({}));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const OLDER = '90000000-0000-4000-8000-000000000001';
const NEWER = '90000000-0000-4000-8000-000000000002';
const CONNECTED: SocketState = { provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null };
const LIMITS = {
  defaults: { width: 1920, height: 1080, fps: { num: 24, den: 1 } },
  assets: { pageSize: 50, pageMax: 100 },
  webAnimation: { promptMaxLength: 4000, durationSeconds: { min: 1, max: 60, default: 4 }, aspects: ['16:9', '9:16', '1:1'], playerLoadTimeoutMs: 15000, sourceRefreshIntervalMs: 3_600_000 },
};
const clients: QueryClient[] = [];

/**
 * A finished create row as the list answers it.
 * @param id - The execution.
 * @param request - Its request.
 * @param createdAt - When it was made.
 * @returns The row.
 */
function done(id: string, request: string, createdAt: string): Record<string, unknown> {
  return {
    id, projectId: PROJECT, spaceId: SPACE, actorUserId: 'u1', actionId: id, inputHash: 'sha256:x', attempt: 1, fence: null,
    billedCredits: '0.30', billedAt: createdAt, origin: 'web_animation_space', status: 'succeeded', phase: null, steps: [],
    failureReason: null, ownProject: true, usageCredits: 0.3, deadlineAt: createdAt, createdAt, updatedAt: createdAt,
    kind: 'web_animation_create', engine: 'deepseek', request, export: null,
    input: { prompt: request, engine: 'deepseek', aspect: '16:9', durationSeconds: 4, fps: { num: 24, den: 1 } },
    resultSourceVersionId: `80000000-0000-4000-8000-${id.slice(-12)}`, resultAssetId: null,
  };
}

/**
 * Answer this Space's list with these rows in the done group, nothing in progress and no Timeline-made group.
 * @param rows - The finished rows, newest first.
 */
function listing(rows: Array<Record<string, unknown>>): void {
  vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string }) => (
    params.group === 'running' || params.scope === 'timeline'
      ? { rows: [], nextCursor: null, totals: params.scope === 'timeline' ? { done: 0, inProgress: 0 } : { done: rows.length, inProgress: 0 } }
      : { rows, nextCursor: null, totals: { done: rows.length, inProgress: 0 } }
  ) as never);
}

/**
 * Render the Motion Space for an Editor or a Viewer.
 * @param readOnly - Whether the user is a Viewer.
 * @returns The Space's element.
 */
function show(readOnly = false): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={CONNECTED}>
    <div data-region='space' data-testid='space-region'>
      <WebAnimationSpace projectId={PROJECT} spaceId={SPACE} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} />
    </div>
  </SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
  return screen.getByTestId('space-region');
}

beforeEach(() => {
  _resetForTests();
  listing([]);
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue(LIMITS as never);
  vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: 'https://preview.example/web-animation/t/index.html' });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  _resetForTests();
});

describe('the bottom bar', () => {
  it('holds every control: play first, the Executions, Annotations and New group last', async () => {
    show();
    const bar = await screen.findByTestId('motion-bottom-bar');
    const ids = within(bar).getAllByRole('button').map((button) => button.getAttribute('data-testid'));
    expect(ids[0]).toBe('motion-play');
    expect(ids.slice(-3)).toEqual(['motion-open-executions', 'motion-open-annotations', 'motion-new']);
  });

  it('shows icons only, named by their tooltips', async () => {
    show();
    for (const [id, key] of [['motion-open-executions', 'spaces.webAnimation.executions'], ['motion-open-annotations', 'spaces.webAnimation.annotations'], ['motion-new', 'spaces.webAnimation.new']] as const) {
      const button = await screen.findByTestId(id);
      expect(button).toHaveAccessibleName(t(key));
      expect(button.textContent?.trim()).toBe('');
    }
  });

  it('has no top bar above the preview', async () => {
    show();
    await screen.findByTestId('motion-bottom-bar');
    expect(screen.queryByTestId('motion-top-bar')).toBeNull();
  });

  it('shows a Viewer the lists but not New', async () => {
    show(true);
    expect(await screen.findByTestId('motion-open-executions')).toBeInTheDocument();
    expect(screen.getByTestId('motion-open-annotations')).toBeInTheDocument();
    expect(screen.queryByTestId('motion-new')).toBeNull();
  });
});

describe('the preview', () => {
  it('offers New in the middle when the Space has no web animation yet', async () => {
    show();
    const empty = await screen.findByTestId('motion-empty');
    expect(empty).toHaveTextContent(t('spaces.webAnimation.empty'));
    expect(within(empty).getByTestId('motion-empty-new')).toBeInTheDocument();
  });

  it('opens the newest finished result', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
  });
});

describe('the two panels', () => {
  it('opens the execution list docked inside the Space, and closes it on a second press', async () => {
    const region = show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    expect(region.contains(panel)).toBe(true);
    expect(screen.getByTestId('motion-open-executions')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('motion-open-executions'));
    expect(screen.queryByTestId('motion-panel-executions')).toBeNull();
  });

  it('keeps one panel open at a time and closes it with Esc', async () => {
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    await user.click(screen.getByTestId('motion-open-annotations'));
    expect(screen.queryByTestId('motion-panel-executions')).toBeNull();
    expect(await screen.findByTestId('motion-panel-annotations')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('motion-panel-annotations')).toBeNull();
  });

  it('lists finished rows under Completed with the group totals, titled by the one title rule', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await userEvent.setup().click(await screen.findByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    expect(await within(panel).findByTestId(`motion-row-${NEWER}`)).toHaveTextContent('Newer logo');
    expect(within(panel).getByRole('tab', { name: new RegExp(t('spaces.webAnimation.completed')) })).toHaveTextContent('1');
  });
});

describe('the current result\'s actions', () => {
  it('offers an Editor Add annotation, Modify and Export on a finished result', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    const bar = await screen.findByTestId('motion-bottom-bar');
    expect(await within(bar).findByTestId('motion-action-add-annotation')).toHaveAccessibleName(t('spaces.webAnimation.addAnnotation'));
    expect(within(bar).getByTestId('motion-action-modify')).toHaveAccessibleName(t('spaces.webAnimation.modify'));
    expect(within(bar).getByTestId('motion-action-export')).toHaveAccessibleName(t('spaces.webAnimation.export'));
  });

  it('turns Export into View video when this Space already has the result\'s export', async () => {
    const exportId = '90000000-0000-4000-8000-0000000000e1';
    listing([{ ...done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), export: { executionId: exportId, status: 'running' } }]);
    show();
    const bar = await screen.findByTestId('motion-bottom-bar');
    expect(await within(bar).findByTestId('motion-action-view-video')).toHaveAccessibleName(t('spaces.webAnimation.viewVideo'));
    expect(within(bar).queryByTestId('motion-action-export')).toBeNull();
  });

  it('shows a Viewer none of the actions that write', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show(true);
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    for (const id of ['motion-action-add-annotation', 'motion-action-modify', 'motion-action-export']) expect(screen.queryByTestId(id)).toBeNull();
  });
});

