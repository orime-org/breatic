// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Timeline execution that waits for a free slot (inner#1968, test spec G-39;
 * the confirmed demo's queued Timeline execution page).
 *
 * A row carrying `slotWaitSince` says Queued with the hourglass and without the
 * working spinner, its detail says why (`canvas.task.waitReasonLimit`) and it
 * offers Cancel, with the limit the row carries in `slotWaitLimit`.
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
  // The user started the execution, so its reason says "you".
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
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), resultSourceVersionId: null, failureReason: null, failureUpstream: null, failureKeyReason: null,
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
    // inner#1968 visual round 1: the canvas's hourglass, so a wait does not read as stuck.
    expect(within(status).getByTestId('task-waiting-mark')).toBeInTheDocument();
    const detail = screen.getByTestId(`timeline-execution-detail-${ID}`);
    expect(detail.textContent).toContain('你同时运行的任务已达上限（2 个），前面的任务结束后自动开始');
    expect(within(detail).getByRole('button', { name: '取消' })).toBeInTheDocument();
  });
});
