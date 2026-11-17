// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The states every web-animation list shares (#1490 design §7.3, §8.2): waiting only before the first answer, the
 * whole-list failure only when that first read failed, and a failed background read or Load more keeping what is shown;
 * Retry and Load more wait while they read, and a failed Load more turns into Retry.
 */

import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';

import { ListLoadError, LoadMoreButton, listShows } from '@web/spaces/web-animation/list-states';

afterEach(cleanup);

const READY = { isPending: false, isLoadingError: false };

describe('listShows', () => {
  it('waits while any list has not answered yet', () => {
    expect(listShows({ isPending: true, isLoadingError: false }, { isPending: false, isLoadingError: true })).toBe('pending');
  });

  it('fails as a whole only when a first read failed', () => {
    expect(listShows(READY, { isPending: false, isLoadingError: true })).toBe('failed');
  });

  it('keeps what is shown when a background read or Load more failed', () => {
    expect(listShows(READY, READY)).toBe('ready');
  });
});

describe('ListLoadError', () => {
  it('says the list failed and waits on Retry while it reads again', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ListLoadError message='List failed' retrying={false} onRetry={onRetry} />);
    expect(screen.getByText('List failed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: t('timeline.retry') }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<ListLoadError message='List failed' retrying onRetry={onRetry} />);
    expect(screen.getByRole('button', { name: t('timeline.retry') })).toHaveAttribute('aria-busy', 'true');
  });
});

describe('LoadMoreButton', () => {
  const idle = { hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage: vi.fn(async () => undefined) };

  it('draws nothing without a next page', () => {
    const { container } = render(<LoadMoreButton query={{ ...idle, hasNextPage: false }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads Load more, and waits while the next page is read', () => {
    const { rerender } = render(<LoadMoreButton query={idle} />);
    expect(screen.getByRole('button', { name: t('timeline.webAnimation.picker.loadMore') })).not.toHaveAttribute('aria-busy');
    rerender(<LoadMoreButton query={{ ...idle, isFetchingNextPage: true }} />);
    expect(screen.getByRole('button', { name: t('timeline.webAnimation.picker.loadMore') })).toHaveAttribute('aria-busy', 'true');
  });

  it('turns into Retry after the next page failed, which reads it again', async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    render(<LoadMoreButton query={{ ...idle, isFetchNextPageError: true, fetchNextPage }} />);
    await userEvent.click(screen.getByRole('button', { name: t('timeline.retry') }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });
});
