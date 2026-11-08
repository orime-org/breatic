// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 6 (inner#1790 web spec 21.1, design 5.6,
 * W9): one user operation leaves as exactly one Update message, so collab
 * never sees the first half of an operation cross the limit and refuses the
 * second half at `full`.
 *
 * Counting (spec 21.1 "数法"): the document's provider is the real
 * `HocuspocusProvider` that production `acquireDocProvider` builds, with the
 * configuration production gives it; only the shared WebSocket is a
 * recording stand-in (`helpers/message-socket.ts`). Each Update frame is
 * judged by shared `updateShape` against a mirror of the document taken when
 * the operation starts. The count runs from the operation until real timers
 * have been idle for well over 50 ms; nothing flushes React effects with
 * `act` during the count. The size state is `N` (`U` for MS-15, as the spec
 * row says).
 *
 * Template `M1`: exactly one Update message; applying it to the mirror gives
 * the document as it now is; its shape is the one the row names.
 */

import type * as React from 'react';
import { vi } from 'vitest';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/message-socket')).messageSocketModule(await importOriginal()));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
vi.mock('@web/data/api/assets', () => ({
  assetsApi: { reportDeleted: vi.fn(() => Promise.resolve()), fetchUploadConfig: vi.fn(() => Promise.reject(new Error('offline'))) },
}));
// Radix Tooltip needs the app-level provider; not under test here.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import { recordingSockets } from '@web/data/yjs/__tests__/helpers/message-socket';
import { defineOneActionSuite } from '@web/data/yjs/__tests__/helpers/one-action-suite';
import { acquireDocProvider } from '@web/data/yjs/collab-socket';
import { getDoc } from '@web/data/yjs/manager';

defineOneActionSuite({
  reset: () => {
    recordingSockets.length = 0;
  },
  open: (name) => {
    const doc = getDoc(name);
    acquireDocProvider(name, doc);
    const socket = recordingSockets.at(-1);
    if (socket === undefined) throw new Error('no socket');
    return Promise.resolve({ doc, socket });
  },
});
