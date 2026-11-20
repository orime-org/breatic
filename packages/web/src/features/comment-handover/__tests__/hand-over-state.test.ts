// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { AgentConnectionItem } from '@breatic/shared';
import type { SpaceAssignment } from '@web/data/api/agent-access';
import { handOverChoices, handOverLabel } from '@web/features/comment-handover/hand-over-state';

const pending: SpaceAssignment = { threadId: 't', connectionId: 'c1', assignedAt: 100, status: 'pending' };

/**
 * A connection of mine.
 * @param over - Fields to change.
 * @returns It.
 */
const conn = (over: Partial<AgentConnectionItem> = {}): AgentConnectionItem => ({
  id: 'c1',
  kind: 'cimd',
  displayName: 'Claude Code',
  createdAt: '2026-11-03T00:00:00Z',
  lastUsedAt: null,
  status: 'active',
  ...over,
});

const base = { record: pending, open: true, connections: [conn()] };

describe('handOverLabel', () => {
  it('waits on an active connection while the record of my hand-over is pending', () => {
    expect(handOverLabel(base)).toEqual({ kind: 'waiting', connectionId: 'c1' });
  });

  it('shows nothing without a record of my hand-over, which is how others see the thread', () => {
    expect(handOverLabel({ ...base, record: undefined })).toBeNull();
  });

  it('shows nothing once the record says answered', () => {
    expect(handOverLabel({ ...base, record: { ...pending, status: 'answered' } })).toBeNull();
  });

  it('shows nothing on a thread that is gone or resolved', () => {
    expect(handOverLabel({ ...base, open: false })).toBeNull();
  });

  it('says an expired OAuth connection comes back on reconnecting', () => {
    expect(handOverLabel({ ...base, connections: [conn({ status: 'expired', kind: 'dcr' })] })).toEqual({
      kind: 'expiredReconnect',
      connectionId: 'c1',
    });
  });

  it('says an expired token will not answer', () => {
    expect(handOverLabel({ ...base, connections: [conn({ status: 'expired', kind: 'pat' })] })).toEqual({
      kind: 'expiredToken',
      connectionId: 'c1',
    });
  });

  it('says a connection no longer in the list was disconnected', () => {
    expect(handOverLabel({ ...base, connections: [] })).toEqual({ kind: 'disconnected', connectionId: 'c1' });
  });

  it('shows nothing while the connections are still loading', () => {
    expect(handOverLabel({ ...base, connections: undefined })).toBeNull();
  });
});

describe('handOverChoices', () => {
  it('lists active connections only, the one that just answered first and marked', () => {
    const list = handOverChoices(
      [conn({ id: 'c2', displayName: 'Cursor' }), conn(), conn({ id: 'c3', status: 'expired' })],
      'c1',
    );
    expect(list.map((c) => [c.id, c.again])).toEqual([
      ['c1', true],
      ['c2', false],
    ]);
  });

  it('tells two connections of the same name apart', () => {
    const list = handOverChoices(
      [conn(), conn({ id: 'c4', kind: 'pat', tokenPrefix: 'brt_3f9a' }), conn({ id: 'c2', displayName: 'Cursor' })],
      null,
    );
    expect(list.map((c) => c.tellApart)).toEqual([
      { kind: 'since', at: '2026-11-03T00:00:00Z' },
      { kind: 'token', prefix: 'brt_3f9a' },
      null,
    ]);
  });
});
