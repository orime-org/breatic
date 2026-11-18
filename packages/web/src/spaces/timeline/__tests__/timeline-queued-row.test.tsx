// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A Timeline execution that waits for a free slot (inner#1968, test spec G-39;
 * the confirmed demo's "排队中 · Timeline 执行" page).
 *
 * A row carrying `slotWaitSince` says "排队中" without the working spinner, its
 * detail says why ("你同时运行的任务已达上限（{limit} 个），前面的任务结束后自动开始")
 * and it offers "取消". The limit is not pinned to a number: the row does not
 * carry it in the design.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { setLocale, type TimelineExecutionRow } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { TimelineExecutionList } from '@web/spaces/timeline/TimelineExecutionList';
import { useCurrentUserStore } from '@web/stores/current-user';

const ID = '90000000-0000-4000-8000-0000000000q1';

beforeEach(() => {
  setLocale('zh-CN');
  // The reader started the execution, so its reason says "you".
  useCurrentUserStore.getState().setUser({ id: 'u', name: 'u', email: 'u@x.test', personalStudio: null, membershipTier: 'base' });
});
afterEach(() => {
  cleanup();
  setLocale('en');
});

/**
 * A queued execution that waits for a slot.
 * @returns The row.
 */
function waitingRow(): TimelineExecutionRow {
  return {
    id: ID, projectId: 'p', spaceId: 's', actorUserId: 'u', kind: 'web_animation_create', actionId: 'a',
    input: { prompt: '海边日落的标题动画', engine: 'deepseek', aspect: '16:9', durationSeconds: 8, fps: { num: 24, den: 1 } },
    inputHash: 'sha256:q', engine: 'deepseek', status: 'queued', phase: null, steps: [], attempt: 1, fence: null,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), resultSourceVersionId: null, failureReason: null,
    billedCredits: null, billedAt: null, createdAt: '2026-11-15T08:00:00.000Z', updatedAt: '2026-11-15T08:00:00.000Z',
    usageCredits: 0, slotWaitSince: '2026-11-15T08:00:01.000Z', slotWaitLimit: 2,
  } as TimelineExecutionRow;
}

describe('G-39 a Timeline execution waiting for a slot', () => {
  it('says queued without the working spinner, says why, and offers cancel', () => {
    const onCancel = vi.fn();
    render(
      <TooltipProvider>
        <TimelineExecutionList projectId='p' rows={[waitingRow()]} view='inProgress' openId={ID} readOnly={false}
          onView={vi.fn()} onToggle={vi.fn()} onClose={vi.fn()} onCancel={onCancel} onAdd={vi.fn()} onRetry={vi.fn()} />
      </TooltipProvider>,
    );
    const status = screen.getByTestId(`timeline-execution-status-${ID}`);
    expect(status).toHaveTextContent('排队中');
    expect(status.querySelector('.animate-spin')).toBeNull();
    const detail = screen.getByTestId(`timeline-execution-detail-${ID}`);
    expect(detail.textContent).toMatch(/你同时运行的任务已达上限（\d+ 个），前面的任务结束后自动开始/);
    expect(within(detail).getByRole('button', { name: '取消' })).toBeInTheDocument();
  });
});
