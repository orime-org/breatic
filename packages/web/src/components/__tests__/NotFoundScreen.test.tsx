// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type * as SharedModule from '@breatic/shared';
import type { DesktopBridge } from '@breatic/shared';

import { NotFoundScreen } from '@web/components/NotFoundScreen';

const locale = vi.hoisted(() => ({ value: 'en' }));

vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  getLocale: () => locale.value,
}));

/** Make the page run inside the desktop client, as its preload does. */
function inDesktopClient(): void {
  (window as { breaticDesktop?: DesktopBridge }).breaticDesktop = { platform: 'darwin' } as DesktopBridge;
}

afterEach(() => {
  delete (window as { breaticDesktop?: DesktopBridge }).breaticDesktop;
  locale.value = 'en';
});

describe('NotFoundScreen', () => {
  it('links a browser to the home page in its language', () => {
    render(<NotFoundScreen />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/');
    locale.value = 'zh-CN';
    render(<NotFoundScreen />);
    expect(screen.getAllByRole('link')[1]).toHaveAttribute('href', '/zh-CN/');
  });

  it('links the desktop client to the Studio, which its window keeps', () => {
    inDesktopClient();
    locale.value = 'zh-CN';
    render(<NotFoundScreen />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/studio');
  });
});
