// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 16: the size notice (N-01 to N-08, N-12).
 *
 * Pushes arrive on the provider's stateless channel, as collab sends them
 * (`{ type: 'doc:size', bytes, limit, ceiling, phase }`). `SpaceOutlet`, the
 * size notice and the read-only notice are the real components; only the
 * Space body is stood in for. Every Space type uses the same sentences; past
 * the hard ceiling the notice carries `data-over-ceiling` (lint/smoke spec
 * answer Q-03) and keeps `data-phase="full"`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { formatBytes, spaceContentDocName } from '@breatic/shared';

vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()),
);
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
// The body each Space type renders is not under test; the outlet's own
// wiring of the two notices is.
vi.mock('@web/spaces', () => {
  /**
   * Stands in for a Space body.
   * @returns A marker element.
   */
  const Body = (): React.JSX.Element => <div data-testid='space-body-stub' />;
  return {
    SPACE_TYPES: {
      canvas: { type: 'canvas', label: 'Canvas', icon: 'x', bodyComponent: Body },
      document: { type: 'document', label: 'Document', icon: 'x', bodyComponent: Body },
      timeline: { type: 'timeline', label: 'Timeline', icon: 'x', bodyComponent: Body },
      '3d': { type: '3d', label: '3D', icon: 'x', bodyComponent: Body },
    },
  };
});

import { SpaceOutlet } from '@web/pages/project/SpaceOutlet';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import {
  latestProvider,
  push,
  refuse,
  resetProviderSpies,
  type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_V2_EN,
  FORMATTED_BYTES_V2,
  P_CEIL,
  P_FULL,
  P_FULL_EDGE,
  P_NORMAL,
  P_OVER,
  P_UNLIMITED,
  P_WARNING,
  type DocSizePushV2,
} from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';

type Kind = 'canvas' | 'document' | 'timeline' | '3d';

const INFO_TONE = ['border-status-info-border', 'bg-status-info-bg', 'text-status-info-foreground'];
const WARNING_TONE = ['border-status-warning-border', 'bg-status-warning-bg', 'text-status-warning-foreground'];

const WRITABLE: SocketState = {
  provider: null,
  synced: true,
  hasEverSynced: true,
  status: 'connected',
  writeAccess: 'granted',
  authFailedReason: null,
};

/**
 * Opens a Space's content document the way a tab does.
 * @param kind - The Space type.
 * @returns Its provider stand-in.
 */
function open(kind: Kind): ProviderSpy {
  const name = spaceContentDocName(PID, SID, kind);
  acquireDocProvider(name, getDoc(name));
  return latestProvider(name);
}

/**
 * Renders the Space through the real outlet.
 * @param kind - The Space type.
 * @param options - Viewer role and the connection's write access.
 * @param options.readOnly - The user's role is view-only.
 * @param options.writeAccess - What the server granted this connection.
 * @returns The render result.
 */
function renderOutlet(kind: Kind, options: { readOnly?: boolean; writeAccess?: SocketState['writeAccess'] } = {}): ReturnType<typeof render> {
  return render(
    <SpaceConnectionContext.Provider value={{ ...WRITABLE, writeAccess: options.writeAccess ?? 'granted' }}>
      <SpaceOutlet projectId={PID} spaceId={SID} type={kind} readOnly={options.readOnly} />
    </SpaceConnectionContext.Provider>,
  );
}

/**
 * The size notice, or null when none is rendered.
 * @returns The element.
 */
function notice(): HTMLElement | null {
  return screen.queryByTestId('space-size-notice');
}

/**
 * Asserts the notice shows exactly this sentence, in this phase and tone.
 * @param phase - The expected `data-phase`.
 * @param text - The expected sentence.
 * @param tone - The expected token classes.
 * @param overCeiling - Whether `data-over-ceiling` is on it.
 */
function expectNotice(phase: string, text: string, tone: readonly string[], overCeiling: boolean): void {
  const el = screen.getByTestId('space-size-notice');
  expect(el).toHaveAttribute('data-phase', phase);
  expect(el).toHaveAttribute('role', 'status');
  expect(el.textContent).toBe(text);
  for (const cls of tone) expect(el).toHaveClass(cls);
  expect(el.hasAttribute('data-over-ceiling')).toBe(overCeiling);
}

/**
 * The notice sentence for a push, its figures from shared `formatBytes`.
 * @param fixture - The push.
 * @param sentence - The sentence template.
 * @returns The sentence.
 */
function sentenceFor(fixture: DocSizePushV2, sentence: (u: string, l: string) => string): string {
  return sentence(formatBytes(fixture.bytes), formatBytes(fixture.limit));
}

beforeEach(() => {
  changeLocale('en');
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  resetProviderSpies();
});

describe('N-01 no notice while the size is unknown, normal or unlimited', () => {
  it('N-01 nothing before a push, after normal and after unlimited; a warning push on the same mount shows it', () => {
    const provider = open('canvas');
    renderOutlet('canvas');
    expect(screen.getByTestId('space-body-stub')).toBeInTheDocument();
    expect(notice()).toBeNull();
    push(provider, P_NORMAL);
    expect(notice()).toBeNull();
    push(provider, P_UNLIMITED);
    expect(notice()).toBeNull();
    // A control on the same mount: the next push is one that shows.
    push(provider, P_WARNING);
    expect(notice()).not.toBeNull();
    push(provider, P_UNLIMITED);
    expect(notice()).toBeNull();
  });
});

describe('N-02 warning', () => {
  it('N-02 the info notice with the usage and the limit', () => {
    const provider = open('canvas');
    renderOutlet('canvas');
    push(provider, P_WARNING);
    expectNotice('warning', COPY_V2_EN.N_WARNING('9 MiB', '10 MiB'), INFO_TONE, false);
  });
});

describe('N-03 full, below the ceiling', () => {
  it.each([
    ['P_FULL', P_FULL, '10 MiB'],
    ['P_FULL_EDGE', P_FULL_EDGE, '10.2 MiB'],
  ] as const)('N-03 %s: the full notice in the warning tone, not over the ceiling', (_label, fixture, used) => {
    const provider = open('canvas');
    renderOutlet('canvas');
    push(provider, fixture);
    expectNotice('full', COPY_V2_EN.N_FULL(used, '10 MiB'), WARNING_TONE, false);
  });
});

describe('N-04 over the ceiling', () => {
  it.each([
    ['P_OVER', P_OVER, '12 MiB'],
    ['P_CEIL (bytes equal to the ceiling)', P_CEIL, '10.3 MiB'],
  ] as const)('N-04 %s: the over-limit notice, data-over-ceiling set', (_label, fixture, used) => {
    const provider = open('canvas');
    renderOutlet('canvas');
    push(provider, fixture);
    expectNotice('full', COPY_V2_EN.N_OVER(used, '10 MiB'), WARNING_TONE, true);
  });
});

describe('N-05 every Space type says the same', () => {
  it.each<Kind>(['canvas', 'document', 'timeline', '3d'])('N-05 %s: full shows the shared full sentence', (kind) => {
    const provider = open(kind);
    renderOutlet(kind);
    push(provider, P_FULL);
    expectNotice('full', COPY_V2_EN.N_FULL('10 MiB', '10 MiB'), WARNING_TONE, false);
    const text = notice()!.textContent;
    expect(text).not.toBe('This Space is full and cannot take more.');
    expect(text).not.toBe('This Space is full and can no longer be edited.');
  });
});

describe('N-06 a rebuild keeps the notice of the state before it', () => {
  it('N-06 full, then the refusal: still the full notice', () => {
    const provider = open('canvas');
    renderOutlet('canvas');
    push(provider, P_FULL);
    refuse(provider);
    expectNotice('full', COPY_V2_EN.N_FULL('10 MiB', '10 MiB'), WARNING_TONE, false);
  });

  it('N-06 warning, then the refusal: still the warning notice', () => {
    const provider = open('canvas');
    renderOutlet('canvas');
    push(provider, P_WARNING);
    refuse(provider);
    expectNotice('warning', COPY_V2_EN.N_WARNING('9 MiB', '10 MiB'), INFO_TONE, false);
  });
});

describe('N-07 a viewer sees no size notice', () => {
  it.each([
    ['full', P_FULL],
    ['over the ceiling', P_OVER],
  ] as const)('N-07 %s: nothing for a viewer, the notice for someone who can write', (_label, fixture) => {
    const provider = open('canvas');
    push(provider, fixture);
    const viewer = renderOutlet('canvas', { readOnly: true });
    expect(screen.getByTestId('space-body-stub')).toBeInTheDocument();
    expect(notice()).toBeNull();
    viewer.unmount();

    renderOutlet('canvas');
    expect(notice()).not.toBeNull();
  });
});

describe('N-08 the size notice stacks under the read-only notice', () => {
  it('N-08 a writer whose connection was made read-only, full: both in one container, read-only first', () => {
    const provider = open('canvas');
    push(provider, P_FULL);
    renderOutlet('canvas', { writeAccess: 'denied' });
    const readOnly = screen.getByTestId('space-read-only-notice');
    const size = screen.getByTestId('space-size-notice');

    expect(readOnly.compareDocumentPosition(size) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(size.parentElement).toBe(readOnly.parentElement);
    expect(readOnly).not.toHaveClass('absolute');
    expect(size).not.toHaveClass('absolute');
    expect(size.parentElement).toHaveClass('absolute');
  });
});

describe('N-12 the figures are shared formatBytes', () => {
  it.each(FORMATTED_BYTES_V2)('N-12 formatBytes(%i) is %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it.each([
    ['P_WARNING', P_WARNING, COPY_V2_EN.N_WARNING],
    ['P_FULL_EDGE', P_FULL_EDGE, COPY_V2_EN.N_FULL],
    ['P_OVER', P_OVER, COPY_V2_EN.N_OVER],
  ] as const)('N-12 %s: the notice shows formatBytes of bytes and of limit', (_label, fixture, sentence) => {
    const provider = open('document');
    renderOutlet('document');
    push(provider, fixture);
    expect(notice()!.textContent).toBe(sentenceFor(fixture, sentence));
  });
});
