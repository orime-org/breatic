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
import { EMPTY_RESOLVED } from '@web/data/api/notifications';
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
      payload: { requesterUserId: 'u-alex', projectId: 'proj-9' },
    });
    // Names and links come from the resolved map, so a later rename changes
    // what this row shows without touching the stored notification.
    const resolved = {
      users: { 'u-alex': { slug: 'alex-h', name: 'Alex', deleted: false } },
      studios: {},
      projects: { 'proj-9': { slug: 'my-proj', name: 'My Project', deleted: false } },
    };
    render(<MemoryRouter>{notificationHeadline(n, resolved, t)}</MemoryRouter>);

    const actorLink = screen.getByRole('link', { name: /Alex/ });
    expect(actorLink).toHaveAttribute('href', '/studio/alex-h');
    expect(actorLink).toHaveTextContent('@alex-h');

    // The project entity links to the canonical `/project/{slug}-{id}` URL.
    const projLink = screen.getByRole('link', { name: 'My Project' });
    expect(projLink).toHaveAttribute('href', '/project/my-proj-proj-9');

    // Both links open in a NEW tab so the reader keeps their place in the bell
    // (the popover stays open); `noopener noreferrer` for the cross-tab handoff.
    expect(actorLink).toHaveAttribute('target', '_blank');
    expect(actorLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(projLink).toHaveAttribute('target', '_blank');
    expect(projLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the studio entity link for a studio invite', () => {
    const n = makeNotification({
      type: 'studio.invite_request',
      payload: { inviterUserId: 'u-bo', studioId: 's-design' },
    });
    const resolved = {
      users: { 'u-bo': { slug: 'bo-h', name: 'Bo', deleted: false } },
      studios: { 's-design': { slug: 'design-team', name: 'Design Team', deleted: false } },
      projects: {},
    };
    render(<MemoryRouter>{notificationHeadline(n, resolved, t)}</MemoryRouter>);

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
      payload: { requesterUserId: 'u-gone', requesterName: 'Alex', projectId: 'proj-9' },
    });
    // The actor is absent from the resolved map (deleted account, or a user
    // mid-onboarding with no personal studio) — the row keeps the stored name
    // as text but must not render a link to nowhere.
    const resolved = {
      users: {},
      studios: {},
      projects: { 'proj-9': { slug: 'my-proj', name: 'My Project', deleted: false } },
    };
    render(<MemoryRouter>{notificationHeadline(n, resolved, t)}</MemoryRouter>);

    // The actor is plain text — only the project entity link remains.
    expect(screen.queryByRole('link', { name: /Alex/ })).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText(/Alex/)).toBeInTheDocument();
  });

  it('names a soft-deleted target but does not link to it', () => {
    // Deactivation is not erasure: the row still has to read as a record of
    // what happened, so the name stays and only the link goes.
    const n = makeNotification({
      type: 'studio.invite_request',
      payload: { inviterUserId: 'u-bo', studioId: 's-gone' },
    });
    const resolved = {
      users: { 'u-bo': { slug: 'bo-h', name: 'Bo', deleted: false } },
      studios: { 's-gone': { slug: 'design-team', name: 'Design Team', deleted: true } },
      projects: {},
    };
    const { container } = render(
      <MemoryRouter>{notificationHeadline(n, resolved, t)}</MemoryRouter>,
    );

    // Named, but not a link. (Checked on the rendered text rather than by
    // element, since the headline interpolates the label into a sentence.)
    expect(container.textContent).toContain('Design Team');
    expect(screen.queryByRole('link', { name: 'Design Team' })).toBeNull();
    // The still-live actor keeps its link.
    expect(screen.getByRole('link', { name: /Bo/ })).toBeInTheDocument();
  });

  it('renders a membership that ended as a plain sentence', () => {
    // 这一条没有「谁做的」也没有「对哪个东西做的」——订阅到期了，不是有人对
    // 你做了什么。所以它不走 actor/entity 那套框架，直接出一句话。
    const tt = fakeT({
      'notifications.headline.membershipEnded': '{tier} 会员已结束',
    });
    const n = makeNotification({
      type: 'membership.ended',
      payload: { fromTier: 'pro' },
    });
    render(
      <MemoryRouter>
        <span data-testid='m'>
          {notificationHeadline(n, EMPTY_RESOLVED, tt)}
        </span>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('m')).toHaveTextContent('PRO 会员已结束');
    expect(screen.getByTestId('m').querySelectorAll('a')).toHaveLength(0);
  });

  it('falls back to the raw type for an unhandled type', () => {
    const n = makeNotification({
      type: 'unknown.future_type' as Notification['type'],
      payload: {},
    });
    render(
      <MemoryRouter>
        <span data-testid='h'>
          {notificationHeadline(n, EMPTY_RESOLVED, t)}
        </span>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('h')).toHaveTextContent('unknown.future_type');
  });
});
