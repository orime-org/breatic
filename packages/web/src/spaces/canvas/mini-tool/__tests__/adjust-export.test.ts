// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which filter backend the picture adjust exports through (inner#1303 §4):
 * Fabric's shared WebGL backend draws on a fixed square, so a picture longer
 * than that square gets a backend of its own, up to what the graphics take.
 */

import { describe, expect, it } from 'vitest';

import { exportBackendSide } from '@web/spaces/canvas/mini-tool/adjust-export';

describe('exportBackendSide', () => {
  it('uses the shared backend for a picture that fits its square', () => {
    expect(exportBackendSide(4096, { shared: 4096, max: 16384 })).toBe('shared');
  });

  it('asks for a backend as long as a picture past the shared square', () => {
    expect(exportBackendSide(6000, { shared: 4096, max: 16384 })).toBe(6000);
  });

  it('refuses a picture past what the graphics take', () => {
    expect(exportBackendSide(16385, { shared: 4096, max: 16384 })).toBe('tooLarge');
  });

  it('uses the shared backend whatever the size when it filters without WebGL', () => {
    expect(exportBackendSide(20000, { shared: Infinity, max: Infinity })).toBe('shared');
  });
});
