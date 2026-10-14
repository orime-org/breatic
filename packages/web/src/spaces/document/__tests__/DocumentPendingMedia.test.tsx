// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a pending media block is drawn (inner#1351 design §5.5, demo
 * `2026-10-14-1351-pending-media-block.html`): the whole thing is the block's
 * media frame, its buttons sit in the media chrome, and the frame names the
 * file only when the block has no caption.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { DocumentPendingMedia } from '@web/spaces/document/DocumentPendingMedia';
import type { PendingStatus } from '@web/spaces/document/document-pending-status';

afterEach(() => {
  cleanup();
});

const FAILURE = { messageKey: 'canvas.upload.failed', params: {}, retryable: true };

/**
 * Renders one pending block.
 * @param status - What it shows.
 * @param caption - Its caption.
 * @returns The callbacks.
 */
function draw(status: PendingStatus, caption = ''): { onRetry: ReturnType<typeof vi.fn>; onRemove: ReturnType<typeof vi.fn> } {
  const onRetry = vi.fn();
  const onRemove = vi.fn();
  render(<DocumentPendingMedia name='cover.png' caption={caption} status={status} onRetry={onRetry} onRemove={onRemove} />);
  return { onRetry, onRemove };
}

/**
 * The block's root.
 * @returns It.
 */
function root(): HTMLElement {
  return screen.getByTestId('doc-pending-media');
}

describe('the frame', () => {
  it('is the block\'s media frame and says which state it is in', () => {
    draw({ kind: 'uploading', progress: 0.42 });
    expect(root().hasAttribute('data-media-frame')).toBe(true);
    expect(root().dataset['status']).toBe('uploading');
  });

  it('names the file when the block has no caption', () => {
    draw({ kind: 'uploading', progress: null });
    expect(screen.getByTestId('doc-pending-name').textContent).toBe('cover.png');
  });

  it('shows the state alone when the block has a caption', () => {
    draw({ kind: 'uploading', progress: null }, 'Hero');
    expect(screen.queryByTestId('doc-pending-name')).toBeNull();
  });

  it('shows the share sent while uploading with a known size', () => {
    draw({ kind: 'uploading', progress: 0.42 });
    expect(screen.getByTestId('doc-pending-progress').getAttribute('aria-valuenow')).toBe('42');
  });
});

describe('its buttons', () => {
  /**
   * The buttons on screen.
   * @returns Their test ids.
   */
  function buttons(): string[] {
    return Array.from(root().querySelectorAll('[data-media-chrome] button')).map((b) => b.getAttribute('data-testid') ?? '');
  }

  it.each<[PendingStatus, string[]]>([
    [{ kind: 'uploading', progress: null }, []],
    [{ kind: 'failed', failure: FAILURE }, ['doc-pending-retry', 'doc-pending-remove']],
    [{ kind: 'failed', failure: { ...FAILURE, retryable: false } }, ['doc-pending-remove']],
    [{ kind: 'waitingDemoted' }, []],
    [{ kind: 'waitingRefused' }, []],
    [{ kind: 'peerUploading' }, []],
    [{ kind: 'peerFailed' }, []],
    [{ kind: 'notFinished' }, ['doc-pending-remove']],
  ])('%o → %o', (status, expected) => {
    draw(status);
    expect(buttons()).toEqual(expected);
  });

  it('retry and remove call back', () => {
    const { onRetry, onRemove } = draw({ kind: 'failed', failure: FAILURE });
    fireEvent.click(screen.getByTestId('doc-pending-retry'));
    fireEvent.click(screen.getByTestId('doc-pending-remove'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
