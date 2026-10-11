// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page, Request } from 'playwright/test';

// The record is a path relative to where the suite runs; these cases run in a
// directory of their own, so the smoke suite's record is never touched.
const home = process.cwd();
let scratch = '';

const { roomForUploads, watchUploadTickets } = await import('../upload-budget');

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

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'upload-budget-'));
  process.chdir(scratch);
});

afterAll(() => {
  process.chdir(home);
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(scratch, 'playwright'), { recursive: true, force: true });
});

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

  it('still holds a batch after the process that recorded the tickets is gone', async () => {
    // Playwright replaces its worker after a failing case; the server's window
    // does not reset with it.
    vi.useFakeTimers();
    const { page, ask } = fakePage();
    watchUploadTickets(page, 'A');
    ask(25);
    vi.resetModules();
    const fresh = await import('../upload-budget');
    let through = false;
    void fresh.roomForUploads(5, 'A').then(() => {
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
