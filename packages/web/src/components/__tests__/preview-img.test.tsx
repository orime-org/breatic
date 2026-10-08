// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewImg } from '@web/components/preview-img';
import { resetPreviewFailures } from '@web/lib/preview-src';

const UUID = '18f58aed-b802-4243-a8ea-02d377de9679';
const STORED = `https://resource-dev.breatic.cc/video/2026-09-30/1_${UUID}_cover.png`;

beforeEach(() => {
  resetPreviewFailures();
});

describe('PreviewImg', () => {
  it('loads the preview of a stored image', () => {
    render(<PreviewImg src={STORED} alt='' data-testid='img' />);

    expect(screen.getByTestId('img').getAttribute('src')).toBe(`${STORED}.preview.webp`);
  });

  it('falls back to the original and still tells the caller', () => {
    const onError = vi.fn();
    render(<PreviewImg src={STORED} alt='' data-testid='img' onError={onError} />);

    fireEvent.error(screen.getByTestId('img'));

    expect(screen.getByTestId('img').getAttribute('src')).toBe(STORED);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('passes the rest of the props through', () => {
    render(<PreviewImg src={STORED} alt='cover' data-testid='img' className='h-6' />);

    expect(screen.getByTestId('img')).toHaveAttribute('alt', 'cover');
    expect(screen.getByTestId('img')).toHaveClass('h-6');
  });
});
