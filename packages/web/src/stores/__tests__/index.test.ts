// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import * as stores from '@web/stores/index';

describe('stores barrel', () => {
  it('re-exports all 9 store hooks', () => {
    expect(typeof stores.useUIStore).toBe('function');
    expect(typeof stores.usePreferencesStore).toBe('function');
    expect(typeof stores.useCurrentUserStore).toBe('function');
    expect(typeof stores.useCanvasStore).toBe('function');
    expect(typeof stores.useProjectStore).toBe('function');
    expect(typeof stores.useToastStore).toBe('function');
  });
});
