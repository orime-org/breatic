// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { AT_END_SLACK_PX, decideFollow } from '@web/pages/project/chat/follow-decision';

const OFF_THE_END = AT_END_SLACK_PX + 1;

describe('decideFollow', () => {
  it('leaves the end when a following column is taken up off it', () => {
    expect(decideFollow(OFF_THE_END, true, 'up')).toBe('leave');
  });

  it('takes the end back when a column that had left is brought down to it', () => {
    expect(decideFollow(0, false, 'down')).toBe('follow');
  });

  it('stays where the reader put it when they nudged up inside the slack', () => {
    // The band every reader crosses first. A wheel turned here has already
    // told the library the reader is leaving, so reading "near the end" as
    // "take me back" writes them down again on every nudge.
    expect(decideFollow(AT_END_SLACK_PX - 1, false, 'up')).toBe('nothing');
    expect(decideFollow(0, false, 'up')).toBe('nothing');
  });

  it('says nothing about a column going the way it is already set to', () => {
    expect(decideFollow(0, true, 'down')).toBe('nothing');
    expect(decideFollow(OFF_THE_END, false, 'up')).toBe('nothing');
    expect(decideFollow(OFF_THE_END, false, 'down')).toBe('nothing');
  });

  it('says nothing about a scroll that moved nothing', () => {
    expect(decideFollow(0, false, 'still')).toBe('nothing');
    expect(decideFollow(OFF_THE_END, true, 'still')).toBe('nothing');
  });

  it('counts the slack itself as being at the end', () => {
    // The line is the library's own: a reader who nudged a few pixels up is
    // still reported as at the end by the hook, so a different line here
    // would have the two disagree about the same reader.
    expect(decideFollow(AT_END_SLACK_PX, false, 'down')).toBe('follow');
    expect(decideFollow(AT_END_SLACK_PX, true, 'up')).toBe('nothing');
    expect(decideFollow(OFF_THE_END, true, 'up')).toBe('leave');
  });

  it('treats a column scrolled past its end as being at it', () => {
    // Overscroll and sub-pixel layout both put the distance below zero, and a
    // column that is past the end is not a reader who has left it.
    expect(decideFollow(-4, false, 'down')).toBe('follow');
  });
});
