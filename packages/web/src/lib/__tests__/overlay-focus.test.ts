// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import type * as React from 'react';

import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';

describe('suppressTooltipFocusOpen', () => {
  it('stops focus propagation so Radix Tooltip never opens from focus', () => {
    // The handler runs in the capture phase on the trigger button; stopping
    // propagation keeps the focus event from reaching Radix Tooltip's own
    // focus handler, so the tooltip only ever opens on hover — never when an
    // overlay close returns focus to the trigger.
    const event = {
      stopPropagation: vi.fn(),
    } as unknown as React.FocusEvent;
    suppressTooltipFocusOpen(event);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});
