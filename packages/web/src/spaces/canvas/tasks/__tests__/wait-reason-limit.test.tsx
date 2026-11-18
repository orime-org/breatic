// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where the queued tip's number comes from (inner#1968 design 21 row 22): the
 * counts' `waitingLimit`, a task row's and a Timeline execution's
 * `slotWaitLimit`. Without one the tip names no number. A row the reader
 * started says "you"; a row someone else started, and the counts column that
 * may hold several people's tasks, name the person who started it.
 */

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@web/data/api/canvas', () => ({
  getCachedUnderstandMaxBytes: vi.fn(() => null),
}));

import { setLocale, type NodeTaskCounts, type NodeTaskEntry, type TimelineExecutionRow } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import { TaskCountColumn } from '@web/spaces/canvas/tasks/TaskCountColumn';
import { TaskRow } from '@web/spaces/canvas/tasks/TaskRow';
import { TimelineExecutionList } from '@web/spaces/timeline/TimelineExecutionList';
import { useCurrentUserStore } from '@web/stores/current-user';

const WITH_LIMIT = '你同时运行的任务已达上限（5 个），前面的任务结束后自动开始';
const OTHER_WITH_LIMIT = '发起人同时运行的任务已达上限（5 个），等发起人前面的任务结束后自动开始';
const OTHER_WITHOUT = '发起人同时运行的任务已达上限，等发起人前面的任务结束后自动开始';

beforeEach(() => {
  setLocale('zh-CN');
  useCurrentUserStore.getState().setUser({ id: 'u', name: 'u', email: 'u@x.test', personalStudio: null, membershipTier: 'base' });
});
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('the queued cell of the counts column', () => {
  it.each<[NodeTaskCounts, string]>([
    [{ running: 2, waiting: 1, waitingLimit: 5, done: 0, failed: 0, expired: 0 }, OTHER_WITH_LIMIT],
    [{ running: 2, waiting: 1, done: 0, failed: 0, expired: 0 }, OTHER_WITHOUT],
  ])('says why with the limit the counts carry: %o', async (counts, said) => {
    render(<TooltipProvider><TaskCountColumn counts={counts} endedShown openFor={null} onOpen={vi.fn()} /></TooltipProvider>);
    await userEvent.hover(screen.getByTestId('task-count-waiting'));
    expect((await screen.findByRole('tooltip')).textContent).toContain(said);
  });
});

describe('a waiting row of the task list', () => {
  it.each([['u', WITH_LIMIT], ['someone-else', OTHER_WITH_LIMIT]])('says why with the limit its task waits under, for a row started by %s', (startedByUserId, said) => {
    const entry = {
      id: 't', projectId: 'p', spaceId: 's', nodeId: 'n', kind: 'generation', action: 'generate', status: 'running',
      startedByUserId, startedAt: '2026-11-15T10:00:00.000Z', settledAt: null, budgetMs: 7_200_000, label: 'm',
      errorMessage: null, nodeHistoryId: null, content: null, coverUrl: null, mediaWidth: null, mediaHeight: null,
      duration: null, mimeType: null, size: null, waitingSince: '2026-11-15T10:00:00.000Z', slotWaitLimit: 5,
    } as NodeTaskEntry;
    render(
      <TooltipProvider>
        <CollaboratorNamesProvider value={{ resolve: () => 'Ada', members: [] }}>
          <TaskRow entry={entry} now={Date.now()} hasRetryFile={false} readOnly={false} retrying={false} dismissing={false}
            onView={vi.fn()} onRetry={vi.fn()} onDismiss={vi.fn()} onCancel={vi.fn()} />
        </CollaboratorNamesProvider>
      </TooltipProvider>,
    );
    expect(screen.getByTestId('node-task-row')).toHaveTextContent(said);
  });
});

describe('a waiting Timeline execution', () => {
  it('says why with the limit it waits under', () => {
    const row = {
      id: 'e1', projectId: 'p', spaceId: 's', actorUserId: 'u', kind: 'web_animation_create', actionId: 'a',
      input: { prompt: 'x', engine: 'deepseek', aspect: '16:9', durationSeconds: 8, fps: { num: 24, den: 1 } },
      inputHash: 'sha256:q', engine: 'deepseek', status: 'queued', phase: null, steps: [], attempt: 1, fence: null,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), resultSourceVersionId: null, failureReason: null,
      billedCredits: null, billedAt: null, createdAt: '2026-11-15T08:00:00.000Z', updatedAt: '2026-11-15T08:00:00.000Z',
      usageCredits: 0, slotWaitSince: '2026-11-15T08:00:01.000Z', slotWaitLimit: 5,
    } as TimelineExecutionRow;
    render(
      <TooltipProvider>
        <TimelineExecutionList projectId='p' rows={[row]} view='inProgress' openId='e1' readOnly={false}
          onView={vi.fn()} onToggle={vi.fn()} onClose={vi.fn()} onCancel={vi.fn()} onAdd={vi.fn()} onRetry={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('timeline-execution-detail-e1')).toHaveTextContent(WITH_LIMIT);
  });
});
