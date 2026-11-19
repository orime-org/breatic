// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { ProjectAgent } from '@web/data/yjs/project-meta';
import { agentRows, agentStatus } from '@web/features/agent-presence/agent-status';

const base: ProjectAgent = { ownerId: 'u1', connectionId: 'c1', online: true, idle: false, lastSeenAt: 1, spaceId: 's1', focus: [], focusAt: null };

describe('agentStatus (#1488 design 19.2)', () => {
  it('says working while online, not idle and naming something', () => {
    expect(agentStatus({ ...base, focus: ['n1'] })).toBe('working');
  });

  it('says online when it has named nothing yet', () => {
    expect(agentStatus(base)).toBe('online');
  });

  it('says idle once idle, whatever it last named', () => {
    expect(agentStatus({ ...base, idle: true, focus: ['n1'] })).toBe('idle');
  });

  it('says offline once offline, idle or not', () => {
    expect(agentStatus({ ...base, online: false, idle: true, focus: ['n1'] })).toBe('offline');
  });
});

describe('agentRows', () => {
  it('lists working, online, idle, then offline, each labelled', () => {
    const rows = agentRows(
      [
        { ...base, connectionId: 'off', online: false },
        { ...base, connectionId: 'idle', idle: true },
        { ...base, connectionId: 'work', focus: ['n1'] },
        { ...base, connectionId: 'on' },
      ],
      new Map([['work', 'W'], ['on', 'O'], ['idle', 'I'], ['off', 'F']]),
    );
    expect(rows.map((r) => [r.connectionId, r.status, r.label])).toEqual([
      ['work', 'working', 'W'],
      ['on', 'online', 'O'],
      ['idle', 'idle', 'I'],
      ['off', 'offline', 'F'],
    ]);
  });
});
