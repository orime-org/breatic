// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { AT_END_SLACK_PX, decideFollow } from '@web/pages/project/chat/follow-decision';

describe('decideFollow', () => {
  it('leaves the end when a following column is no longer at it', () => {
    expect(decideFollow(AT_END_SLACK_PX + 1, true)).toBe('leave');
  });

  it('takes the end back when a column that had left is at it again', () => {
    expect(decideFollow(0, false)).toBe('follow');
  });

  it('says nothing about a column that is where it should be', () => {
    expect(decideFollow(0, true)).toBe('nothing');
    expect(decideFollow(AT_END_SLACK_PX + 1, false)).toBe('nothing');
  });

  it('counts the slack itself as being at the end', () => {
    // The line is the library's own: a reader who nudged a few pixels up is
    // still reported as at the end by the hook, so a different line here
    // would have the two disagree about the same reader.
    expect(decideFollow(AT_END_SLACK_PX, false)).toBe('follow');
    expect(decideFollow(AT_END_SLACK_PX, true)).toBe('nothing');
  });

  it('treats a column scrolled past its end as being at it', () => {
    // Overscroll and sub-pixel layout both put the distance below zero, and a
    // column that is past the end is not a reader who has left it.
    expect(decideFollow(-4, false)).toBe('follow');
  });
});
