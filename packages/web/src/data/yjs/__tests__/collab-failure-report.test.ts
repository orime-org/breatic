// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Tests for collab connection-failure reporting.
 *
 * Regression target: a collab auth rejection used to set only a status
 * enum + render a banner — the close code / reason / doc were dropped,
 * leaving production oncall blind to why a project wouldn't load. These
 * pin that a failure reaches BOTH the console (local dev) and Sentry
 * (production), with the structured detail intact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/react', () => ({ captureMessage: vi.fn() }));
import * as Sentry from '@sentry/react';
import { reportCollabFailure } from '@web/data/yjs/collab-failure-report';

describe('reportCollabFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs an auth failure to console.error with code + reason + doc', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportCollabFailure({
      kind: 'auth',
      docName: 'project-7/meta',
      code: 4403,
      reason: 'Forbidden',
    });
    expect(spy).toHaveBeenCalledOnce();
    const [message, context] = spy.mock.calls[0];
    expect(String(message)).toContain('project-7/meta');
    expect(context).toMatchObject({
      kind: 'auth',
      code: 4403,
      reason: 'Forbidden',
      docName: 'project-7/meta',
    });
    spy.mockRestore();
  });

  it('reports an auth failure to Sentry at error level with structured context', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportCollabFailure({
      kind: 'auth',
      docName: 'project-7/meta',
      code: 4403,
      reason: 'Forbidden',
    });
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    const [message, context] = vi.mocked(Sentry.captureMessage).mock.calls[0];
    expect(message).toContain('project-7/meta');
    expect(context).toMatchObject({
      level: 'error',
      tags: { area: 'collab', kind: 'auth' },
      extra: { docName: 'project-7/meta', code: 4403, reason: 'Forbidden' },
    });
    spy.mockRestore();
  });

  it('reports a non-auth disconnect at warning level (transient, not terminal)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportCollabFailure({ kind: 'disconnect', docName: 'project-7/meta', code: 1006 });
    const [, context] = vi.mocked(Sentry.captureMessage).mock.calls[0];
    expect(context).toMatchObject({ level: 'warning', tags: { kind: 'disconnect' } });
    spy.mockRestore();
  });
});
