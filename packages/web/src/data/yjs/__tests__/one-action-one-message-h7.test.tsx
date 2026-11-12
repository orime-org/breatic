// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 7 (inner#1790 web spec 23.1, X3): the
 * spec 21.1 operations on a provider that finished its handshake (`H7`),
 * where the binding's receipt path is live. Under `H7` the MS rows are:
 * MS-01 is W7-01, MS-02 is W7-02, every other row is W7-05.
 *
 * Besides template `M1`, each count of a canvas or document operation must
 * read `[update, confirm]` among its Update and receipt frames: the
 * `sync:confirm` after the one Update, and no second Update of the same
 * operation after it; once the server's receipt is in, nothing is unsynced.
 * A timeline document has no receipt binding, so its count is `M1` alone.
 */

import type * as React from 'react';
import { afterAll, describe, expect, vi } from 'vitest';

const h7 = await vi.hoisted(async () => {
  const m = await import('@web/data/yjs/__tests__/helpers/handshake-server');
  m.installScriptedWebSocket();
  return m;
});

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
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

import { parseDocName } from '@breatic/shared';
import type { FrameLog, MessageCount } from '@web/data/yjs/__tests__/helpers/message-socket';
import { defineOneActionSuite } from '@web/data/yjs/__tests__/helpers/one-action-suite';
import { acquireDocProvider, hasProjectUnsyncedEdits } from '@web/data/yjs/collab-socket';
import { getDoc } from '@web/data/yjs/manager';

/** The frames of the current server, in the vocabulary `countMessages` reads. */
const log: FrameLog = {
  get frames() {
    return h7.server.current.sentFrames;
  },
};

/**
 * The Update and receipt frames of a count, by spec 23.0 name.
 * @param count - The count.
 * @returns `update` and `confirm`, in order.
 * @throws {never} Never.
 */
function updatesAndConfirms(count: MessageCount): string[] {
  return count.frames().flatMap((frame) => {
    if (frame.kind === 'update') return ['update'];
    if (frame.kind === 'stateless' && frame.payload.includes('"sync:confirm"')) return ['confirm'];
    return [];
  });
}

afterAll(() => {
  h7.uninstallScriptedWebSocket();
});

describe('23.1 W7-01, W7-02 and W7-05 on a handshaken provider (H7)', () => {
  defineOneActionSuite({
    reset: () => {
      h7.resetServer();
    },
    open: async (name) => {
      const doc = getDoc(name);
      const provider = acquireDocProvider(name, doc);
      const kind = parseDocName(name)?.kind;
      await h7.expectHandshake(name, doc, provider as never, { confirms: kind === 'canvas' || kind === 'document' });
      return { doc, socket: log };
    },
    check: (count) => {
      const name = count.frames()[0]?.name ?? '';
      const kind = parseDocName(name)?.kind;
      if (kind !== 'canvas' && kind !== 'document') return;
      expect(updatesAndConfirms(count)).toEqual(['update', 'confirm']);
      expect(hasProjectUnsyncedEdits(parseDocName(name)!.projectId)).toBe(false);
    },
  });
});
