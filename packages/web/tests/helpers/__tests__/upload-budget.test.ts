// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page, Request } from 'playwright/test';

import { roomForUploads, watchUploadTickets } from '../upload-budget';

/**
 * A page that can be told to ask for tickets.
 * @returns The page, and a way to make it ask for some.
 */
function fakePage(): { page: Page; ask: (count: number) => void } {
  let listener: ((req: Request) => void) | undefined;
  const page = {
    on: (_event: string, fn: (req: Request) => void) => {
      listener = fn;
    },
  } as unknown as Page;
  const ticket = {
    method: () => 'POST',
    url: () => 'http://localhost/api/v1/assets/upload-ticket',
  } as unknown as Request;
  return {
    page,
    ask: (count) => {
      for (let i = 0; i < count; i += 1) listener?.(ticket);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('roomForUploads', () => {
  it('lets a batch through while the window has room for it', async () => {
    vi.useFakeTimers();
    const { page, ask } = fakePage();
    watchUploadTickets(page, 'B');
    ask(10);
    let through = false;
    void roomForUploads(15, 'B').then(() => {
      through = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(through).toBe(true);
  });

  it('holds a batch until enough of the window has passed', async () => {
    vi.useFakeTimers();
    const { page, ask } = fakePage();
    watchUploadTickets(page, 'A');
    ask(25);
    let through = false;
    void roomForUploads(5, 'A').then(() => {
      through = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(through).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(through).toBe(true);
  });

  it('refuses a batch the window could never hold', async () => {
    await expect(roomForUploads(40, 'A')).rejects.toThrow('over the');
  });
});
