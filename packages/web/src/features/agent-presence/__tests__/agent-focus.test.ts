// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { ProjectAgent } from '@web/data/yjs/project-meta';
import { agentFocusIn, agentOccupantId, connectionOfOccupant, withAgentOccupants } from '@web/features/agent-presence/agent-focus';

const base: ProjectAgent = { ownerId: 'u1', connectionId: 'c1', online: true, idle: false, lastSeenAt: 1, spaceId: 's1', focus: ['n1', 'n2'] };

describe('agentFocusIn (#1488 design 19.2)', () => {
  it('lists, per item, the agents working on it in this Space', () => {
    const focus = agentFocusIn([base, { ...base, connectionId: 'c2', focus: ['n2'] }], 's1');
    expect(focus.get('n1')).toEqual(['c1']);
    expect(focus.get('n2')).toEqual(['c1', 'c2']);
  });

  it('leaves out agents elsewhere, idle or offline', () => {
    const focus = agentFocusIn(
      [
        { ...base, spaceId: 's2' },
        { ...base, connectionId: 'c2', idle: true },
        { ...base, connectionId: 'c3', online: false },
      ],
      's1',
    );
    expect(focus.size).toBe(0);
  });
});

describe('agent occupant ids', () => {
  it('round-trips a connection and tells a member id apart', () => {
    expect(connectionOfOccupant(agentOccupantId('c1'))).toBe('c1');
    expect(connectionOfOccupant('u1')).toBeNull();
  });
});

describe('withAgentOccupants', () => {
  it('adds agents after the members holding the same item, and items only agents hold', () => {
    const members = new Map([['n1', ['u1']]]);
    const merged = withAgentOccupants(members, new Map([['n1', ['c1']], ['n2', ['c2']]]));
    expect(merged.get('n1')).toEqual(['u1', agentOccupantId('c1')]);
    expect(merged.get('n2')).toEqual([agentOccupantId('c2')]);
  });

  it('hands the members table back unchanged when no agent works here', () => {
    const members = new Map([['n1', ['u1']]]);
    expect(withAgentOccupants(members, new Map())).toBe(members);
  });
});
