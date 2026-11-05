// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap (inner#1790), test spec W-134: every size toast is a
 * warning, and the same sentence twice carries the same id.
 *
 * The one file of the cap that leaves `@web/lib/toast` real and stands in for
 * sonner beneath it, so the type and the de-duplication id the wrapper derives
 * are what is asserted. The triggers are the rows of W-45 and the rejection
 * close of W-121; the over-ceiling deletion of W-105 is a ProseMirror path and
 * is asserted on `toast.warning` in its own file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { spaceContentDocName } from '@breatic/shared';

vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()),
);
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(() => 'id'),
    error: vi.fn(() => 'id'),
    info: vi.fn(() => 'id'),
    success: vi.fn(() => 'id'),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  },
}));

import { toast as sonner } from 'sonner';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { reserveSpaceRoom, writeSpaceDoc } from '@web/data/yjs/space-write';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import {
  latestProvider,
  push,
  refuse,
  resetProviderSpies,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_EN,
  F_FULL,
  F_FULL_NEAR,
  F_OVER,
  F_WARNING,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';

type Kind = 'canvas' | 'document' | 'timeline';
type Call = { kind: 'add' | 'overwrite'; estimate?: number } | { reserve: number };

/** W-45, row by row: Space type, push, call, the sentence it is told with. */
const ROWS: ReadonlyArray<readonly [string, Kind, DocSizePush, Call, string]> = [
  ['canvas add when full', 'canvas', F_FULL, { kind: 'add' }, COPY_EN.T_ADD_BLOCKED],
  ['document add when full', 'document', F_FULL, { kind: 'add' }, COPY_EN.T_ADD_BLOCKED],
  ['canvas overwrite near the ceiling', 'canvas', F_FULL_NEAR, { kind: 'overwrite' }, COPY_EN.T_OVERWRITE_BLOCKED],
  ['document overwrite over the ceiling', 'document', F_OVER, { kind: 'overwrite' }, COPY_EN.T_OVERWRITE_BLOCKED],
  ['canvas add that does not fit', 'canvas', F_WARNING, { kind: 'add', estimate: 786433 }, COPY_EN.T_NO_ROOM('768 KiB')],
  ['timeline add when full', 'timeline', F_FULL, { kind: 'add' }, COPY_EN.T_TIMELINE_FULL],
  ['timeline overwrite near the ceiling', 'timeline', F_FULL_NEAR, { kind: 'overwrite' }, COPY_EN.T_TIMELINE_FULL],
  ['timeline add that does not fit', 'timeline', F_WARNING, { kind: 'add', estimate: 786433 }, COPY_EN.T_NO_ROOM('768 KiB')],
  ['canvas reservation when full', 'canvas', F_FULL, { reserve: 1 }, COPY_EN.T_ADD_BLOCKED],
];

let space = 0;

/**
 * Opens a fresh Space document of a type, at a push.
 * @param kind - The Space type.
 * @param at - The push it starts at.
 * @returns The document name.
 * @throws {Error} When acquiring fails.
 */
function openAt(kind: Kind, at: DocSizePush): string {
  space += 1;
  const name = spaceContentDocName(PID, `22222222-2222-4222-8222-${String(space).padStart(12, '0')}`, kind);
  acquireDocProvider(name, getDoc(name));
  push(latestProvider(name), at);
  return name;
}

/**
 * Makes one W-45 call.
 * @param name - Document name.
 * @param call - The call.
 * @throws {never} The gateway does not throw.
 */
function make(name: string, call: Call): void {
  if ('reserve' in call) {
    reserveSpaceRoom(name, call.reserve, { notify: true });
    return;
  }
  writeSpaceDoc(name, { ...call, notify: true }, vi.fn());
}

/**
 * Asserts sonner was asked for exactly these warnings and nothing else.
 * @param message - The sentence.
 * @param times - How many times it was shown.
 * @throws {AssertionError} When anything differs.
 */
function expectWarnings(message: string, times: number): void {
  expect(sonner.warning).toHaveBeenCalledTimes(times);
  for (const [text, options] of vi.mocked(sonner.warning).mock.calls) {
    expect(text).toBe(message);
    expect((options as { id?: unknown } | undefined)?.id).toBe(`warning:${message}`);
  }
  expect(sonner.error).not.toHaveBeenCalled();
  expect(sonner.info).not.toHaveBeenCalled();
  expect(sonner.success).not.toHaveBeenCalled();
}

beforeEach(() => {
  changeLocale('en');
  vi.mocked(sonner.warning).mockClear();
  vi.mocked(sonner.error).mockClear();
  vi.mocked(sonner.info).mockClear();
  vi.mocked(sonner.success).mockClear();
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  resetProviderSpies();
});

describe('W-134 size toasts are warnings with a sentence-derived id', () => {
  it.each(ROWS)('%s', (_label, kind, at, call, message) => {
    const name = openAt(kind, at);
    make(name, call);
    expectWarnings(message, 1);
  });

  it.each(ROWS)('%s, twice: both carry the same id', (_label, kind, at, call, message) => {
    const name = openAt(kind, at);
    make(name, call);
    make(name, call);
    expectWarnings(message, 2);
    const [[, first], [, second]] = vi.mocked(sonner.warning).mock.calls;
    expect((first as { id: unknown }).id).toBe((second as { id: unknown }).id);
  });

  it('the rejection close (W-121) is told once, as a warning', () => {
    const name = openAt('canvas', F_FULL);
    refuse(latestProvider(name));
    expectWarnings(COPY_EN.T_RESYNC, 1);
  });
});
