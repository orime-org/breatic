// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { AgentConnectionItem, AnnotationAssignment } from '@breatic/shared';
import {
  answeredHandOver,
  handOverChoices,
  handOverLabel,
} from '@web/features/comment-handover/hand-over-state';

const ME = 'u1';
const handed: AnnotationAssignment = { connectionId: 'c1', assignedBy: ME, assignedAt: 100, projectId: 'p1' };

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

const base = {
  assignment: handed,
  viewerId: ME,
  projectId: 'p1',
  answered: false,
  resolved: false,
  record: undefined,
  connections: [conn()],
};

describe('handOverLabel', () => {
  it('waits on an active connection', () => {
    expect(handOverLabel(base)).toEqual({ kind: 'waiting', connectionId: 'c1' });
  });

  it('shows nothing to anyone but the one who handed it over', () => {
    expect(handOverLabel({ ...base, viewerId: 'u2' })).toBeNull();
  });

  it('shows nothing for a thread handed over in another project', () => {
    expect(handOverLabel({ ...base, assignment: { ...handed, projectId: 'p0' } })).toBeNull();
  });

  it('follows the record once it has caught up with this hand-over', () => {
    expect(handOverLabel({ ...base, record: { threadId: 't', connectionId: 'c1', assignedAt: 100, status: 'answered' } })).toBeNull();
  });

  it('keeps its own reading while the record is of an earlier hand-over', () => {
    expect(handOverLabel({ ...base, record: { threadId: 't', connectionId: 'c1', assignedAt: 50, status: 'answered' } })).toEqual({
      kind: 'waiting',
      connectionId: 'c1',
    });
  });

  it('stops waiting once the agent answered or the thread was resolved, before the record says so', () => {
    expect(handOverLabel({ ...base, answered: true })).toBeNull();
    expect(handOverLabel({ ...base, resolved: true })).toBeNull();
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

describe('answeredHandOver', () => {
  it('finds the reply the handed-to connection wrote for this hand-over', () => {
    expect(answeredHandOver(handed, [{ via: 'c1', answers: 100 }])).toBe(true);
  });

  it('ignores a reply for an earlier hand-over or by another connection', () => {
    expect(answeredHandOver(handed, [{ via: 'c1', answers: 50 }, { via: 'c2', answers: 100 }])).toBe(false);
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
