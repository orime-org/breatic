// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import {
  notificationHeadline,
  renderSlottedText,
} from '@web/features/notifications/notification-headline';
import type { Notification } from '@web/data/api/notifications';
import type { useTranslation } from '@web/i18n/use-translation';

const NUL = String.fromCodePoint(0);

/** A fake `t()` that interpolates `{name}` placeholders from a template map. */
function fakeT(
  templates: Record<string, string>,
): ReturnType<typeof useTranslation> {
  return ((key: string, params?: Record<string, string | number | Date>) => {
    const tmpl = templates[key];
    if (tmpl === undefined) return key;
    return tmpl.replace(/\{(\w+)\}/g, (_m, name: string) =>
      String(params?.[name] ?? ''),
    );
  }) as ReturnType<typeof useTranslation>;
}

function makeNotification(over: Partial<Notification>): Notification {
  return {
    id: 'n-1',
    userId: 'u-1',
    type: 'access.role_upgrade_request',
    payload: {},
    projectId: null,
    readAt: null,
    expiresAt: null,
    createdAt: '2026-06-22T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
    deletedAt: null,
    ...over,
  };
}

describe('renderSlottedText', () => {
  it('splits NUL-delimited markers and drops nodes in at their positions', () => {
    const text = `${NUL}actor${NUL} invited you to ${NUL}entity${NUL}`;
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

describe('notificationHeadline', () => {
  const t = fakeT({
    'notifications.headline.roleUpgradeRequest':
      '{actor} requested editor on {project}',
    'notifications.headline.studioInviteRequest':
      '{actor} invited you to {studio}',
    'notifications.actorFallback': 'Someone',
  });

  it('renders the actor (name + @handle → personal studio) and the project entity link', () => {
    const n = makeNotification({
      type: 'access.role_upgrade_request',
      projectId: 'proj-9',
      payload: {
        requesterName: 'Alex',
        requesterHandle: 'alex-h',
        projectName: 'My Project',
        projectSlug: 'my-proj',
      },
    });
    render(<MemoryRouter>{notificationHeadline(n, t)}</MemoryRouter>);

    const actorLink = screen.getByRole('link', { name: /Alex/ });
    expect(actorLink).toHaveAttribute('href', '/studio/alex-h');
    expect(actorLink).toHaveTextContent('@alex-h');

    // The project entity links to the canonical `/project/{slug}-{id}` URL.
    const projLink = screen.getByRole('link', { name: 'My Project' });
    expect(projLink).toHaveAttribute('href', '/project/my-proj-proj-9');
  });

  it('renders the studio entity link for a studio invite', () => {
    const n = makeNotification({
      type: 'studio.invite_request',
      payload: {
        inviterName: 'Bo',
        inviterHandle: 'bo-h',
        studioName: 'Design Team',
        studioSlug: 'design-team',
      },
    });
    render(<MemoryRouter>{notificationHeadline(n, t)}</MemoryRouter>);

    expect(screen.getByRole('link', { name: /Bo/ })).toHaveAttribute(
      'href',
      '/studio/bo-h',
    );
    expect(screen.getByRole('link', { name: 'Design Team' })).toHaveAttribute(
      'href',
      '/studio/design-team',
    );
  });

  it('degrades the actor to plain text (no broken link) when the handle is missing', () => {
    const n = makeNotification({
      type: 'access.role_upgrade_request',
      projectId: 'proj-9',
      payload: {
        requesterName: 'Alex',
        requesterHandle: '',
        projectName: 'My Project',
      },
    });
    render(<MemoryRouter>{notificationHeadline(n, t)}</MemoryRouter>);

    // The actor is plain text — only the project entity link remains.
    expect(screen.queryByRole('link', { name: /Alex/ })).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText(/Alex/)).toBeInTheDocument();
  });

  it('falls back to the raw type for an unhandled type', () => {
    const n = makeNotification({
      type: 'unknown.future_type' as Notification['type'],
      payload: {},
    });
    render(
      <MemoryRouter>
        <span data-testid='h'>{notificationHeadline(n, t)}</span>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('h')).toHaveTextContent('unknown.future_type');
  });
});
