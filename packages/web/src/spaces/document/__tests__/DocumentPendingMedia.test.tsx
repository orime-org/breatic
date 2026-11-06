// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
import type { PendingFailureReason, UploadFailure } from '@web/spaces/document/document-upload-controller';

afterEach(() => {
  cleanup();
});

const FAILURE: UploadFailure = { reason: 'failed', retryable: true };

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

  it('has its caption under it, as a media block does, when it has one', () => {
    draw({ kind: 'uploading', progress: null }, 'Hero');
    const caption = screen.getByTestId('doc-media-caption');
    expect(caption).toHaveTextContent('Hero');
    expect(root().compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(root().contains(caption)).toBe(false);
  });

  it('has no caption under it when it has none', () => {
    draw({ kind: 'uploading', progress: null });
    expect(screen.queryByTestId('doc-media-caption')).toBeNull();
  });

  it('shows the state alone when the block has a caption', () => {
    draw({ kind: 'uploading', progress: null }, 'Hero');
    expect(screen.queryByTestId('doc-pending-name')).toBeNull();
  });

  it('shows the share sent while uploading with a known size', () => {
    draw({ kind: 'uploading', progress: 0.42 });
    expect(screen.getByTestId('doc-pending-progress').getAttribute('aria-valuenow')).toBe('42');
  });

  it('keeps its numbers one width, so a changing percent does not move the name', () => {
    draw({ kind: 'uploading', progress: 0.42 });
    expect(root().className).toContain('tabular-nums');
  });

  it('gives every line the height of its buttons, so a failure does not move the body below', () => {
    draw({ kind: 'uploading', progress: null });
    expect(root().className).toContain('leading-[var(--btn-compact)]');
  });

  it('is held to the width it is given, so a cell does not widen around it', () => {
    draw({ kind: 'uploading', progress: null });
    expect(root().parentElement!.className).toContain('@container');
    expect(root().className).toContain('flex-wrap');
  });
});

describe('a failure', () => {
  it.each<[PendingStatus, string]>([
    [{ kind: 'failed', failure: FAILURE }, 'cover.png · Upload failed'],
    [{ kind: 'failed', failure: { reason: 'tooLarge', retryable: false } }, 'cover.png · Exceeds the upload size limit'],
    [{ kind: 'peerFailed' }, 'cover.png · Upload failed'],
  ])('%o names the file and the reason in one line', (status, said) => {
    draw(status);
    expect(screen.getByTestId('doc-pending-failure').textContent).toBe(said);
    expect(screen.queryByTestId('doc-pending-name')).toBeNull();
  });

  it('says the reason alone when the block has a caption', () => {
    draw({ kind: 'failed', failure: FAILURE }, 'Hero');
    expect(screen.getByTestId('doc-pending-failure').textContent).toBe('Upload failed');
  });

  it.each<[PendingFailureReason, string]>([
    ['failed', 'Upload failed'],
    ['storageFull', 'Studio storage is full'],
    ['rateLimited', 'Uploading too often, try again later'],
    ['hashUnavailable', 'Couldn’t verify the file, reload the page'],
    ['unsupportedType', 'Format not supported'],
    ['tooLarge', 'Exceeds the upload size limit'],
    ['empty', 'The file is empty'],
    ['unreachable', 'The address won’t open'],
  ])('%s says %s', (reason, said) => {
    draw({ kind: 'failed', failure: { reason, retryable: false } }, 'Hero');
    expect(screen.getByTestId('doc-pending-failure').textContent).toBe(said);
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
