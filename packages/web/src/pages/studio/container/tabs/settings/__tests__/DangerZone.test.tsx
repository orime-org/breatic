// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the danger zone holds, per studio type and per role.
 *
 * The zone used to be hidden entirely from a personal studio, on the grounds
 * that its three actions — transfer, delete, leave — are all meaningless for
 * one. That reasoning was about those three actions and was wrongly read as a
 * rule about the box, which is how changing the slug ended up beside the
 * display name. A personal studio's slug is its owner's handle: changing it
 * breaks every link to them and frees the name for anyone, which is exactly
 * what this box is for.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { DangerZone } from '@web/pages/studio/container/tabs/settings/DangerZone';
import type {
  StudioDetail,
  StudioMember,
} from '@web/pages/studio/container/container-types';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));
vi.mock('@web/domain/use-debounce', () => ({
  useDebounce: <T,>(value: T): T => value,
}));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    liveTransfer: vi.fn().mockResolvedValue(null),
    checkSlugAvailable: vi.fn().mockResolvedValue({ available: true }),
  },
}));

/** Every action cell the zone can hold, by the test id of its entry point. */
const CELLS = {
  transfer: 'settings-transfer-open',
  delete: 'settings-delete',
  slug: 'settings-slug-open',
  leave: 'settings-leave-open',
} as const;

/**
 * Build a studio detail, overriding what a case cares about.
 * @param over - The fields this case varies.
 * @returns The studio detail.
 */
function studio(over: Partial<StudioDetail> = {}): StudioDetail {
  return {
    id: 's1',
    slug: 'acme-studio',
    name: 'Acme',
    type: 'team',
    avatarUrl: null,
    bio: null,
    memberCount: 3,
    myStudioRole: 'admin',
    ...over,
  };
}

/**
 * Render the danger zone for a studio.
 * @param detail - The studio being governed.
 * @returns The render result.
 */
function renderZone(detail: StudioDetail): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const members: readonly StudioMember[] = [];
  return render(
    <QueryClientProvider client={qc}>
      <DangerZone
        studio={detail}
        members={members}
        leaving={false}
        onLeave={vi.fn()}
        saving={false}
        onSave={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

/**
 * Assert exactly which cells the zone is showing.
 * @param present - The cell keys that must be there; every other must not be.
 */
function expectCells(present: readonly (keyof typeof CELLS)[]): void {
  for (const key of Object.keys(CELLS) as (keyof typeof CELLS)[]) {
    const testId = CELLS[key];
    if (present.includes(key)) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    } else {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DangerZone — what each kind of viewer gets', () => {
  it('gives a personal studio exactly one action: changing the slug', () => {
    renderZone(studio({ type: 'personal', myStudioRole: 'admin' }));
    expectCells(['slug']);
  });

  it('gives the admin of a team studio all three governance actions', () => {
    renderZone(studio({ type: 'team', myStudioRole: 'admin' }));
    expectCells(['transfer', 'delete', 'slug']);
  });

  it('gives a team member who is not the admin only the way out', () => {
    renderZone(studio({ type: 'team', myStudioRole: 'maintainer' }));
    expectCells(['leave']);
  });

  it('gives a guest the same, and never the slug', () => {
    renderZone(studio({ type: 'team', myStudioRole: 'guest' }));
    expectCells(['leave']);
  });

  it('renders nothing at all for a non-member', () => {
    const { container } = renderZone(studio({ myStudioRole: null }));
    expect(container).toBeEmptyDOMElement();
  });
});
