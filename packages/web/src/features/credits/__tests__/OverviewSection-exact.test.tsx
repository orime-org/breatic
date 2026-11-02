// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale, type CreditOverview } from '@breatic/shared';
import { OverviewSection } from '@web/features/credits/sections/OverviewSection';

/**
 * Supply the approved wire representation independently of the current DTO type.
 * @param assignedCredits - Credits assigned to studios.
 * @param unassignedCredits - Credits held by the account.
 * @param values - Per-studio exact balances.
 * @returns The overview fixture passed to the real component.
 */
function overview(assignedCredits: string, unassignedCredits: string, values: readonly string[] = []): CreditOverview {
  return {
    billing: true,
    assignedCredits,
    unassignedCredits,
    underRefundCredits: '0.000000',
    studios: values.map((value, index) => ({
      studioId: `00000000-0000-4000-8000-00000000000${index + 1}`,
      studioName: `Studio ${index + 1}`,
      studioSlug: `studio-${index + 1}`,
      deleted: false,
      spendable: value,
      debt: '0.000000',
      spent: '0.000000',
      lotCount: 1,
    })),
  } as unknown as CreditOverview;
}

beforeEach(() => { setLocale('en'); });
afterEach(cleanup);

describe('exact credit overview rendering', () => {
  it('M19 displays the exact account total across large credit sources', () => {
    render(<OverviewSection overview={overview('9007199254.740000', '9007199254.730000')} />);
    expect(screen.getByText('18,014,398,509.47')).toBeInTheDocument();
    expect(screen.getByText('9,007,199,254.74')).toBeInTheDocument();
    expect(screen.getByText('9,007,199,254.73')).toBeInTheDocument();
  });

  it.each([
    { total: '4.000000', values: ['1.000000', '3.000000'], shares: [0.25, 0.75], second: 'Studio 2 3' },
    { total: '2.000000', values: ['1.000000', '1.000000'], shares: [0.5, 0.5], second: 'Studio 2 1' },
  ])('M19 shows finite distribution $shares with exact labels', ({ total, values, shares, second }) => {
    const { container } = render(<OverviewSection overview={overview(total, '0.000000', values)} />);
    const weights = [...container.querySelectorAll<HTMLElement>('span[style*="flex-grow"]')]
      .map(element => Number(element.style.flexGrow));
    expect(weights).toHaveLength(2);
    expect(weights.every(Number.isFinite)).toBe(true);
    const sum = weights.reduce((total, value) => total + value, 0);
    expect(weights.map(value => value / sum)).toEqual(shares);
    expect(screen.getByText('Studio 1 1')).toBeInTheDocument();
    expect(screen.getByText(second)).toBeInTheDocument();
  });

  it('M19 renders an empty distribution when its exact total is zero', () => {
    const { container } = render(<OverviewSection overview={overview('0.000000', '0.000000')} />);
    expect(container.querySelectorAll('span[style*="flex-grow"]')).toHaveLength(0);
    expect(screen.getAllByText('0')).toHaveLength(3);
    expect(screen.getByText('Credits have to be assigned to a Studio before they can be spent')).toBeInTheDocument();
  });

  it('M19 renders the empty state when existing studios all have zero balances', () => {
    const { container } = render(<OverviewSection overview={overview('0.000000', '0.000000', ['0.000000', '0.000000'])} />);
    expect(container.querySelectorAll('span[style*="flex-grow"]')).toHaveLength(0);
    expect(screen.getAllByText('0')).toHaveLength(3);
    expect(screen.getByText('Credits have to be assigned to a Studio before they can be spent')).toBeInTheDocument();
  });

  it('M19 retains exact large distribution labels and finite equal weights', () => {
    const { container } = render(<OverviewSection overview={overview(
      '199999999999999.980000', '0.000000',
      ['99999999999999.990000', '99999999999999.990000'],
    )} />);
    expect(screen.getAllByText('199,999,999,999,999.98')).toHaveLength(2);
    expect(screen.getByText('Studio 1 99,999,999,999,999.99')).toBeInTheDocument();
    expect(screen.getByText('Studio 2 99,999,999,999,999.99')).toBeInTheDocument();
    const weights = [...container.querySelectorAll<HTMLElement>('span[style*="flex-grow"]')]
      .map(element => Number(element.style.flexGrow));
    expect(weights).toHaveLength(2);
    expect(weights.every(Number.isFinite)).toBe(true);
    const sum = weights.reduce((total, value) => total + value, 0);
    expect(weights.map(value => value / sum)).toEqual([0.5, 0.5]);
  });
});
