// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 execution design §9.4, §10.5 and §10.8 copy rows: the line of a failed step outside every person or window
 * (an expiry, for example) follows the item that blocks a retry, as the item lines do, instead of telling the user to
 * retry while no retry is offered. With only retryable items the shared line still says retry and the button shows.
 * Translation is real.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '@breatic/shared';
import type { ExpandFailureReason, LipsyncFailureReason } from '@breatic/shared/mini-tools';
import { LipSyncFailure } from '../video/VideoToolControls';
import { ModelRunFailure } from '../video/ModelRunFailure';

afterEach(cleanup);

/**
 * A video tool message.
 * @param key - The key under `canvas.miniTool.videoUI`.
 * @param values - The ICU values.
 * @returns The rendered text.
 */
const ui = (key: string, values?: Record<string, number>): string => t(`canvas.miniTool.videoUI.${key}`, values);

const EXPIRED = { step: 'expired', category: 'timeout' } as const;

describe('lip-sync shared line follows the person that blocks a retry (§9.4)', () => {
  it('an expiry beside a person with no face names that person and offers no retry', () => {
    const reason: LipsyncFailureReason = { kind: 'lipsync', persons: [
      { personId: 'p1', detectionNumber: 1, step: 'faces', category: 'no_face' },
      { personId: 'p2', detectionNumber: 2, step: 'faces', category: 'timeout' },
    ], shared: EXPIRED };
    render(<LipSyncFailure reason={reason} disabled={false} onRetry={() => undefined} />);
    const block = screen.getByTestId('video-lip-sync-failure');
    expect(within(block).getAllByText(ui('personFailFollowNext', { number: 1 }))).toHaveLength(2);
    expect(within(block).queryByText(ui('personFailRetryNext'))).toBeNull();
    expect(within(block).queryByRole('button', { name: ui('retryFailedPeople') })).toBeNull();
  });

  it('an expiry beside timeouts only still says retry and offers it', () => {
    const reason: LipsyncFailureReason = { kind: 'lipsync', persons: [{ personId: 'p1', detectionNumber: 1, step: 'faces', category: 'timeout' }], shared: EXPIRED };
    render(<LipSyncFailure reason={reason} disabled={false} onRetry={() => undefined} />);
    const block = screen.getByTestId('video-lip-sync-failure');
    expect(within(block).getAllByText(ui('personFailRetryNext'))).toHaveLength(2);
    expect(within(block).getByRole('button', { name: ui('retryFailedPeople') })).toBeInTheDocument();
  });
});

describe('expand shared line after an expiry (§10.5)', () => {
  it('an expiry beside timeouts only still says retry and offers it', () => {
    const reason: ExpandFailureReason = { kind: 'expand', windows: [{ windowIndex: 0, step: 'generate', category: 'timeout' }], shared: EXPIRED };
    render(<ModelRunFailure reason={reason} disabled={false} onRetry={() => undefined} />);
    const block = screen.getByTestId('video-model-run-failure');
    expect(within(block).getAllByText(ui('personFailRetryNext'))).toHaveLength(2);
    expect(within(block).getByRole('button', { name: ui('retryFailedItems') })).toBeInTheDocument();
  });
});
