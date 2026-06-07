// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { projectUuidFromRouteParam } from '@web/lib/project-route';

const UUID = 'cece2cbb-9f2a-494e-b91e-c7e541b2540b';

describe('projectUuidFromRouteParam (URL design §5.7 — /project/{slug}-{uuid})', () => {
  it('extracts the trailing uuid from a {slug}-{uuid} composite (slug has hyphens)', () => {
    expect(projectUuidFromRouteParam(`smoke-studio-proj-${UUID}`)).toBe(UUID);
  });

  it('extracts the uuid when the slug is a single word', () => {
    expect(projectUuidFromRouteParam(`album-${UUID}`)).toBe(UUID);
  });

  it('returns a bare uuid unchanged', () => {
    expect(projectUuidFromRouteParam(UUID)).toBe(UUID);
  });

  it('leaves a non-uuid param (e.g. the "demo" fallback) untouched', () => {
    expect(projectUuidFromRouteParam('demo')).toBe('demo');
  });

  it('only matches a uuid anchored at the END (a leading uuid is not mistaken for the id)', () => {
    // A slug that happens to start with a uuid-shaped token but ends in a real
    // uuid still resolves to the trailing one.
    expect(projectUuidFromRouteParam(`${UUID}-suffix-${UUID}`)).toBe(UUID);
  });
});
