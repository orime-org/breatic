// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { renderSlottedText, slotMarker } from '@web/lib/slotted-text';

describe('renderSlottedText', () => {
  it('splits slot markers and drops nodes in at their positions', () => {
    const text = `${slotMarker('actor')} invited you to ${slotMarker('entity')}`;
    render(
      <span data-testid='out'>
        {renderSlottedText(text, {
          actor: <a href='/x'>Alex</a>,
          entity: <a href='/y'>Proj</a>,
        })}
      </span>,
    );
    const out = screen.getByTestId('out');
    expect(out).toHaveTextContent('Alex invited you to Proj');
    expect(out.querySelectorAll('a')).toHaveLength(2);
  });
});
