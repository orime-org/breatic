// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec W-07 and
 * design 5.5: every size toast is a warning, the same sentence for every Space
 * type, and the same sentence twice carries the same id, so de-duplication is
 * the toast wrapper's and not the entry's.
 *
 * The one file of the cap that leaves `@web/lib/toast` real and stands in for
 * sonner beneath it, so the type and the de-duplication id the wrapper derives
 * are what is asserted.
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
import { writeSpaceDoc, type SpaceWriteKind } from '@web/data/yjs/space-write';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import {
  latestProvider,
  push,
  refuse,
  resetProviderSpies,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_V2_EN, P_CEIL, P_FULL, P_OVER, type DocSizePushV2,
} from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';

type Kind = 'canvas' | 'document' | 'timeline' | '3d';

/** Space type, push, refused kind, the sentence it is told with. */
const ROWS: ReadonlyArray<readonly [string, Kind, DocSizePushV2, SpaceWriteKind, string]> = [
  ['canvas add when full', 'canvas', P_FULL, 'add', COPY_V2_EN.T_ADD],
  ['document edit when full', 'document', P_FULL, 'edit', COPY_V2_EN.T_ADD],
  ['timeline add when full', 'timeline', P_FULL, 'add', COPY_V2_EN.T_ADD],
  ['3D edit when full', '3d', P_FULL, 'edit', COPY_V2_EN.T_ADD],
  ['canvas compound when full', 'canvas', P_FULL, 'compound', COPY_V2_EN.T_COMPOUND],
  ['timeline compound when full', 'timeline', P_FULL, 'compound', COPY_V2_EN.T_COMPOUND],
  ['document delete over the ceiling', 'document', P_OVER, 'delete', COPY_V2_EN.T_OVER],
  ['canvas add at the ceiling', 'canvas', P_CEIL, 'add', COPY_V2_EN.T_OVER],
  ['3D delete over the ceiling', '3d', P_OVER, 'delete', COPY_V2_EN.T_OVER],
];

let space = 0;

/**
 * Opens a fresh Space document of a type, at a push.
 * @param kind - The Space type.
 * @param at - The push it starts at.
 * @returns The document name.
 * @throws {Error} When acquiring fails.
 */
function openAt(kind: Kind, at: DocSizePushV2): string {
  space += 1;
  const name = spaceContentDocName(PID, `22222222-2222-4222-8222-${String(space).padStart(12, '0')}`, kind);
  acquireDocProvider(name, getDoc(name));
  push(latestProvider(name), at);
  return name;
}

/**
 * Makes one refused write.
 * @param name - Document name.
 * @param kind - The kind.
 * @throws {never} The gateway does not throw for a full Space.
 */
function make(name: string, kind: SpaceWriteKind): void {
  writeSpaceDoc(name, { kind, notify: true }, vi.fn());
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

describe('W-07 size toasts are warnings with a sentence-derived id', () => {
  it.each(ROWS)('W-07 %s', (_label, kind, at, writeKind, message) => {
    const name = openAt(kind, at);
    make(name, writeKind);
    expectWarnings(message, 1);
  });

  it.each(ROWS)('W-07 %s, twice: both reach sonner with the same id', (_label, kind, at, writeKind, message) => {
    const name = openAt(kind, at);
    make(name, writeKind);
    make(name, writeKind);
    expectWarnings(message, 2);
    const [[, first], [, second]] = vi.mocked(sonner.warning).mock.calls;
    expect((first as { id: unknown }).id).toBe((second as { id: unknown }).id);
  });

  it('Y-02 the refusal close is told once, as a warning', () => {
    const name = openAt('canvas', P_FULL);
    refuse(latestProvider(name));
    expectWarnings(COPY_V2_EN.T_RESYNC, 1);
  });
});
