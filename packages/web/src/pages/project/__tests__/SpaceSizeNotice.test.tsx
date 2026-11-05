// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap (inner#1790), test spec section 14: the size notice
 * (W-127 to W-131).
 *
 * Pushes arrive on the provider's stateless channel, as collab sends them; the
 * notice and the read-only notice are the real components, and so is
 * `SpaceOutlet` around them. Only the Space body is stood in for: it is not
 * what these cases connect to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { spaceContentDocName, type SpaceType } from '@breatic/shared';

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
    },
  };
});

import { SpaceSizeNotice } from '@web/pages/project/SpaceSizeNotice';
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
  synced,
  type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_EN,
  F_FULL,
  F_NORMAL,
  F_OVER_BIG,
  F_UNLIMITED,
  F_WARNING,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';

const INFO_TONE = ['border-status-info-border', 'bg-status-info-bg', 'text-status-info-foreground'];
const WARNING_TONE = ['border-status-warning-border', 'bg-status-warning-bg', 'text-status-warning-foreground'];

/**
 * Opens a Space's content document the way a tab does.
 * @param kind - The Space type.
 * @returns The document name and its provider stand-in.
 * @throws {Error} When acquiring fails.
 */
function open(kind: Exclude<SpaceType, 'meta'> & Parameters<typeof spaceContentDocName>[2]): { name: string; provider: ProviderSpy } {
  const name = spaceContentDocName(PID, SID, kind);
  acquireDocProvider(name, getDoc(name));
  return { name, provider: latestProvider(name) };
}

/**
 * The notice, or null when none is rendered.
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
 * @throws {AssertionError} When anything differs.
 */
function expectNotice(phase: string, text: string, tone: readonly string[]): void {
  const el = screen.getByTestId('space-size-notice');
  expect(el).toHaveAttribute('data-phase', phase);
  expect(el).toHaveAttribute('role', 'status');
  expect(el.textContent).toBe(text);
  for (const cls of tone) expect(el).toHaveClass(cls);
}

const WRITABLE: SocketState = {
  provider: null,
  synced: true,
  hasEverSynced: true,
  status: 'connected',
  writeAccess: 'granted',
  authFailedReason: null,
};

beforeEach(() => {
  changeLocale('en');
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  resetProviderSpies();
});

describe.each(['canvas', 'document'] as const)('W-127 the notice in each phase (%s)', (kind) => {
  it('shows nothing before a push and for normal', () => {
    const { name, provider } = open(kind);
    render(<SpaceSizeNotice docName={name} spaceType={kind} />);
    expect(notice()).toBeNull();
    push(provider, F_NORMAL);
    expect(notice()).toBeNull();
    // A control on the same mount: the next push is one that shows.
    push(provider, F_WARNING);
    expect(notice()).not.toBeNull();
  });

  it('follows warning, full and over-ceiling pushes, and goes away when unlimited', () => {
    const { name, provider } = open(kind);
    render(<SpaceSizeNotice docName={name} spaceType={kind} />);

    push(provider, F_WARNING);
    expectNotice('warning', COPY_EN.T_WARNING('9 MiB', '10 MiB'), INFO_TONE);

    push(provider, F_FULL);
    expectNotice('full', COPY_EN.T_FULL_NOTICE('9.8 MiB', '10 MiB'), WARNING_TONE);

    push(provider, F_OVER_BIG);
    expectNotice('full', COPY_EN.T_FULL_NOTICE('12 MiB', '10 MiB'), WARNING_TONE);

    push(provider, F_UNLIMITED);
    expect(notice()).toBeNull();
  });
});

describe('W-128 a rebuild keeps the notice of the phase before it', () => {
  it('keeps the warning notice through the rejection', () => {
    const { name, provider } = open('canvas');
    render(<SpaceSizeNotice docName={name} spaceType='canvas' />);
    push(provider, F_WARNING);
    refuse(provider);
    expectNotice('warning', COPY_EN.T_WARNING('9 MiB', '10 MiB'), INFO_TONE);
  });

  it('keeps the full notice until the new provider has synced, then follows the latest push', () => {
    const { name, provider } = open('canvas');
    render(<SpaceSizeNotice docName={name} spaceType='canvas' />);
    push(provider, F_FULL);
    refuse(provider);
    expectNotice('full', COPY_EN.T_FULL_NOTICE('9.8 MiB', '10 MiB'), WARNING_TONE);

    // The remounted Space acquires the document again; whatever provider
    // stands for it now is the one the rebuild talks through.
    acquireDocProvider(name, getDoc(name));
    const fresh = latestProvider(name);
    expect(fresh).not.toBe(provider);
    push(fresh, F_NORMAL);
    expectNotice('full', COPY_EN.T_FULL_NOTICE('9.8 MiB', '10 MiB'), WARNING_TONE);

    synced(fresh);
    expect(notice()).toBeNull();
  });
});

describe('W-129 the full notice of timeline and 3D', () => {
  it.each([
    ['timeline', COPY_EN.T_TIMELINE_FULL],
    ['3d', COPY_EN.T_3D_FULL],
  ] as const)('%s: full and warning sentences', (kind, full) => {
    const { name, provider } = open(kind);
    render(<SpaceSizeNotice docName={name} spaceType={kind} />);
    push(provider, F_FULL);
    expect(screen.getByTestId('space-size-notice')).toHaveAttribute('data-phase', 'full');
    expect(screen.getByTestId('space-size-notice').textContent).toBe(full);
    push(provider, F_WARNING);
    expect(screen.getByTestId('space-size-notice')).toHaveAttribute('data-phase', 'warning');
    expect(screen.getByTestId('space-size-notice').textContent).toBe(COPY_EN.T_WARNING('9 MiB', '10 MiB'));
  });
});

/** The states W-130 puts a viewer's Space in. */
const VIEWER_STATES: ReadonlyArray<[string, (provider: ProviderSpy) => void]> = [
  ['warning', (p) => { push(p, F_WARNING); }],
  ['full', (p) => { push(p, F_FULL); }],
  ['over the ceiling', (p) => { push(p, F_OVER_BIG); }],
  ['resyncing', (p) => { push(p, F_FULL); refuse(p); }],
];

describe('W-130 a viewer sees no size notice', () => {
  it.each(VIEWER_STATES)('%s: nothing for the viewer', (_label, reach) => {
    const { provider } = open('canvas');
    reach(provider);
    render(
      <SpaceConnectionContext.Provider value={WRITABLE}>
        <SpaceOutlet projectId={PID} spaceId={SID} type='canvas' readOnly />
      </SpaceConnectionContext.Provider>,
    );
    expect(screen.getByTestId('space-body-stub')).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each(VIEWER_STATES)('%s: the same Space shows the notice to someone who can write', (_label, reach) => {
    const { provider } = open('canvas');
    reach(provider);
    render(
      <SpaceConnectionContext.Provider value={WRITABLE}>
        <SpaceOutlet projectId={PID} spaceId={SID} type='canvas' />
      </SpaceConnectionContext.Provider>,
    );
    expect(notice()).not.toBeNull();
  });
});

describe('W-131 the size notice stacks under the read-only notice', () => {
  it('puts both in one positioned container, read-only first', () => {
    const { provider } = open('canvas');
    push(provider, F_WARNING);
    render(
      <SpaceConnectionContext.Provider value={{ ...WRITABLE, writeAccess: 'denied' }}>
        <SpaceOutlet projectId={PID} spaceId={SID} type='canvas' />
      </SpaceConnectionContext.Provider>,
    );
    const readOnly = screen.getByTestId('space-read-only-notice');
    const size = screen.getByTestId('space-size-notice');

    expect(readOnly.compareDocumentPosition(size) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // One container owns the top-centre placement; neither notice pins itself
    // to the same point on its own.
    expect(size.parentElement).toBe(readOnly.parentElement);
    expect(readOnly).not.toHaveClass('absolute');
    expect(size).not.toHaveClass('absolute');
    expect(size.parentElement).toHaveClass('absolute');
  });
});
