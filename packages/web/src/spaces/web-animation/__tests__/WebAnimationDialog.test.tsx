// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The New and Modify dialog (#1490 design §5.1): a modification shows a small preview of the result it starts from,
 * asks for what to change, and says the picture is laid out again once its aspect or length differs from that result.
 */

import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

import type { CreationDraftInput } from '@web/spaces/web-animation/creation-draft';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';
import { WebAnimationDialog } from '@web/spaces/web-animation/WebAnimationDialog';

vi.mock('@web/spaces/web-animation/MotionResultPlayer', () => ({
  MotionResultPlayer: (props: { sourceVersionId: string; frame: number }) =>
    <div data-testid='base-player' data-source={props.sourceVersionId} data-frame={props.frame} />,
}));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const BASE = '90000000-0000-4000-8000-000000000001';
const BASE_SOURCE = '80000000-0000-4000-8000-000000000001';
const LIMITS = { promptMaxLength: 4000, durationSeconds: { min: 1, max: 60, default: 4 }, aspects: ['16:9', '9:16', '1:1'], playerLoadTimeoutMs: 15000, sourceRefreshIntervalMs: 3_600_000 };

const baseRow = {
  id: BASE, projectId: PROJECT, spaceId: SPACE, actorUserId: 'u1', actionId: BASE, inputHash: 'sha256:x', attempt: 1, fence: null,
  billedCredits: '0.30', billedAt: '2026-11-15T09:00:00.000000Z', origin: 'web_animation_space', status: 'succeeded', phase: null, steps: [],
  failureReason: null, ownProject: true, usageCredits: 0.3, deadlineAt: '2026-11-15T09:00:00.000000Z', createdAt: '2026-11-15T09:00:00.000000Z',
  updatedAt: '2026-11-15T09:00:00.000000Z', kind: 'web_animation_create', engine: 'deepseek', request: 'Gold dot along an arc', export: null,
  input: { prompt: 'Gold dot along an arc', engine: 'deepseek', aspect: '16:9', durationSeconds: 4, fps: { num: 24, den: 1 } },
  resultSourceVersionId: BASE_SOURCE, resultAssetId: null,
} as unknown as WebAnimationRowView;

/**
 * Render the dialog drafting this input.
 * @param input - What the draft holds.
 * @param base - The result a modification starts from, once read.
 */
function show(input: Partial<CreationDraftInput>, base?: WebAnimationRowView): void {
  const full: CreationDraftInput = { base: null, prompt: '', engine: 'deepseek', aspect: '16:9', durationSeconds: 4, ...input };
  render(<WebAnimationDialog projectId={PROJECT} spaceId={SPACE} draft={{ status: 'drafting', open: true, input: full, error: null }} retry={false}
    limits={LIMITS as never} baseRow={base} baseRead={{ failed: false, retrying: false, retry: vi.fn() }} onEdit={vi.fn()} onExecute={vi.fn()} onClose={vi.fn()} />);
}

const MODIFY: Partial<CreationDraftInput> = { base: { executionId: BASE, sourceVersionId: BASE_SOURCE, request: 'Gold dot along an arc' } };

afterEach(cleanup);

describe('the Modify dialog', () => {
  it('shows a small preview of the result it starts from, at its middle frame', () => {
    show(MODIFY, baseRow);
    const card = screen.getByTestId('web-animation-base');
    expect(card).toHaveTextContent(t('spaces.webAnimation.dialog.modifyDescription', { base: 'Gold dot along an arc' }));
    const player = screen.getByTestId('base-player');
    expect(player).toHaveAttribute('data-source', BASE_SOURCE);
    expect(player).toHaveAttribute('data-frame', '48');
  });

  it('asks for what to change', () => {
    show(MODIFY, baseRow);
    expect(screen.getByLabelText(t('spaces.webAnimation.dialog.instruction'))).toBe(screen.getByTestId('web-animation-prompt'));
  });

  it('says nothing about the layout while the aspect and length are the result\'s', () => {
    show(MODIFY, baseRow);
    expect(screen.queryByText(t('spaces.webAnimation.dialog.relayout'))).toBeNull();
  });

  it.each([{ aspect: '9:16' as const }, { durationSeconds: 6 }])('says the picture is laid out again once %o differs from the result', (change) => {
    show({ ...MODIFY, ...change }, baseRow);
    expect(screen.getByText(t('spaces.webAnimation.dialog.relayout'))).toBeInTheDocument();
  });
});

describe('the New dialog', () => {
  it('has no result to start from', () => {
    show({});
    expect(screen.queryByTestId('web-animation-base')).toBeNull();
    expect(screen.queryByText(t('spaces.webAnimation.dialog.relayout'))).toBeNull();
  });
});

describe('the dialog copy', () => {
  it('has the layout notice and the label in all five locales', () => {
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      for (const key of ['spaces.webAnimation.dialog.relayout', 'spaces.webAnimation.dialog.instruction']) {
        expect(String(readPath(catalog, key) ?? ''), `${tag} ${key}`).not.toBe('');
      }
    }
    expect(readPath(LOCALE_CATALOGS.find(([tag]) => tag === 'zh-CN')?.[1], 'spaces.webAnimation.dialog.instruction')).toBe('要改的地方');
  });
});
