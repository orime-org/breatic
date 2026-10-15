// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { spaceRpcFailureNotice } from '@web/pages/project/space-rpc-failure';

describe('spaceRpcFailureNotice', () => {
  it('warns that the cap is reached when a create or restore is refused for it', () => {
    for (const type of ['space:create', 'space:restore'] as const) {
      expect(spaceRpcFailureNotice(type, 'SPACE_LIMIT')).toEqual({
        level: 'warning',
        descriptionKey: 'project.space.error.limit',
      });
    }
  });

  it('asks to try again when another member holds the Space lock', () => {
    for (const type of ['space:create', 'space:delete', 'space:restore'] as const) {
      expect(spaceRpcFailureNotice(type, 'BUSY')).toEqual({
        level: 'error',
        descriptionKey: 'project.space.error.busy',
      });
    }
  });

  it('says the last Space has to stay when a delete is refused for it', () => {
    expect(spaceRpcFailureNotice('space:delete', 'CONFLICT')).toEqual({
      level: 'error',
      descriptionKey: 'project.space.error.lastSpace',
    });
  });

  it('says the Space is already back when a restore is refused for it', () => {
    expect(spaceRpcFailureNotice('space:restore', 'CONFLICT')).toEqual({
      level: 'error',
      descriptionKey: 'project.space.error.alreadyRestored',
    });
  });

  it('says the Space is gone when a delete, lock or rename finds nothing', () => {
    for (const type of ['space:delete', 'space:lock', 'space:rename'] as const) {
      expect(spaceRpcFailureNotice(type, 'NOT_FOUND')).toEqual({
        level: 'error',
        descriptionKey: 'project.space.error.gone',
      });
    }
  });

  it('shows only the title for every other refusal', () => {
    expect(spaceRpcFailureNotice('space:create', 'FORBIDDEN')).toEqual({ level: 'error' });
    expect(spaceRpcFailureNotice('space:rename', 'INVALID_INPUT')).toEqual({ level: 'error' });
    expect(spaceRpcFailureNotice('space:lock', 'INTERNAL')).toEqual({ level: 'error' });
    expect(spaceRpcFailureNotice('space:restore', 'NOT_FOUND')).toEqual({ level: 'error' });
  });
});
