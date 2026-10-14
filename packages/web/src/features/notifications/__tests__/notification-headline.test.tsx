// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { notificationHeadline } from '@web/features/notifications/notification-headline';
import type { Notification } from '@web/data/api/notifications';
import { EMPTY_RESOLVED } from '@web/data/api/notifications';
import type { useTranslation } from '@web/i18n/use-translation';
import { formatCredits, setLocale, t as sharedT } from '@breatic/shared';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';
import type { LocaleTag } from '@web/test-utils/locale-catalogs';

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

  it('names the period an incomplete move was going to', () => {
    const tt = fakeT({
      'notifications.headline.membershipUpgradeIncomplete':
        'payment for your move to {tier} {period} was not completed',
      'membership.period.year': 'yearly',
    });
    const n = makeNotification({
      type: 'membership.upgrade_incomplete',
      payload: { toTier: 'team', toPeriod: 'year' },
    });
    render(
      <MemoryRouter>
        <span data-testid='m'>
          {notificationHeadline(n, EMPTY_RESOLVED, tt)}
        </span>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('m')).toHaveTextContent(
      'payment for your move to Team yearly was not completed',
    );
  });

  it('drops the period from a row that was written before we recorded one', () => {
    // Rows written before the period existed carry no `toPeriod`. Composing
    // the key from an empty string produced `membership.period.`, which
    // resolves to nothing, and an unresolved key is rendered verbatim — so
    // the reader was shown a key name in the middle of a sentence.
    const tt = fakeT({
      'notifications.headline.membershipUpgradeIncomplete':
        'payment for your move to {tier} {period} was not completed',
      'notifications.headline.membershipUpgradeIncompleteNoPeriod':
        'payment for your move to {tier} was not completed',
    });
    const n = makeNotification({
      type: 'membership.upgrade_incomplete',
      payload: { toTier: 'team' },
    });
    render(
      <MemoryRouter>
        <span data-testid='m'>
          {notificationHeadline(n, EMPTY_RESOLVED, tt)}
        </span>
      </MemoryRouter>,
    );
    const text = screen.getByTestId('m').textContent ?? '';
    expect(text).toBe('payment for your move to Team was not completed');
    expect(text).not.toContain('membership.period.');
  });

  // inner#1410 §8. A refund outcome, like a membership that ended, has no
  // actor and nothing to open: one localized sentence. The keys are
  // `notifications.headline.creditRefundCompleted` and
  // `notifications.headline.creditRefundRejected`, and the sentence names how
  // many credits the request was for: the payload's `credits` (a numeric
  // string, '880.000000') written by `formatCreditAmount` in the active locale.
  it.each([
    {
      type: 'credit.refund_completed' as const,
      payload: { lotId: 'lot-1', credits: '880.000000', amountCents: 1080, currency: 'usd' },
      key: 'notifications.headline.creditRefundCompleted',
      template: '{credits} 积分的退款已完成',
      sentence: '880 积分的退款已完成',
    },
    {
      type: 'credit.refund_rejected' as const,
      payload: { lotId: 'lot-2', credits: '880.000000' },
      key: 'notifications.headline.creditRefundRejected',
      template: '{credits} 积分的退款申请未通过',
      sentence: '880 积分的退款申请未通过',
    },
    {
      // inner#1410 v9 §8: the buyer took the credits back instead of the money.
      type: 'credit.refund_restored' as Notification['type'],
      payload: { lotId: 'lot-3', credits: '880.000000' },
      key: 'notifications.headline.creditRefundRestored',
      template: '{credits} 积分已恢复到你的账号',
      sentence: '880 积分已恢复到你的账号',
    },
  ])('renders $type as a plain sentence naming the credits', ({ type, payload, key, template, sentence }) => {
    const tt = fakeT({ [key]: template });
    const n = makeNotification({ type, payload });
    render(
      <MemoryRouter>
        <span data-testid='r'>
          {notificationHeadline(n, EMPTY_RESOLVED, tt)}
        </span>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('r')).toHaveTextContent(sentence);
    // The stored six-decimal string is never shown as stored.
    expect(screen.getByTestId('r').textContent).not.toContain('880.000000');
    expect(screen.getByTestId('r').querySelectorAll('a')).toHaveLength(0);
  });

  /** The design's sentence per locale (§8), `{credits}` still in it. */
  const REFUND_SENTENCES: Record<
    LocaleTag,
    { completed: string; rejected: string }
  > = {
    en: {
      completed: 'Your refund for {credits} credits is complete',
      rejected: 'Your refund request for {credits} credits was not approved',
    },
    'zh-CN': {
      completed: '{credits} 积分的退款已完成',
      rejected: '{credits} 积分的退款申请未通过',
    },
    'zh-TW': {
      completed: '{credits} 點的退款已完成',
      rejected: '{credits} 點的退款申請未通過',
    },
    ja: {
      completed: '{credits} クレジットの返金が完了しました',
      rejected: '{credits} クレジットの返金リクエストは承認されませんでした',
    },
    ko: {
      completed: '{credits} 크레딧 환불이 완료되었습니다',
      rejected: '{credits} 크레딧 환불 요청이 승인되지 않았습니다',
    },
  };

  /**
   * Render a refund row through the real catalog in one locale.
   * @param tag - The locale to render in.
   * @param n - The notification to render.
   * @returns The rendered headline text.
   */
  function renderInLocale(tag: LocaleTag, n: Notification): string {
    try {
      setLocale(tag);
      const { unmount } = render(
        <MemoryRouter>
          <span data-testid='l'>
            {notificationHeadline(n, EMPTY_RESOLVED, sharedT)}
          </span>
        </MemoryRouter>,
      );
      const text = screen.getByTestId('l').textContent ?? '';
      unmount();
      return text;
    } finally {
      setLocale('en');
    }
  }

  describe.each([
    {
      type: 'credit.refund_completed' as const,
      payload: { lotId: 'lot-1', amountCents: 1080, currency: 'usd' },
      key: 'notifications.headline.creditRefundCompleted',
      outcome: 'completed' as const,
    },
    {
      type: 'credit.refund_rejected' as const,
      payload: { lotId: 'lot-2' },
      key: 'notifications.headline.creditRefundRejected',
      outcome: 'rejected' as const,
    },
  ])('$type in every shipped language', ({ type, payload, key, outcome }) => {
    // Asked of the catalog directly as well as through `t()`: `t()` falls back
    // to English, so a key missing from one locale would render English and
    // pass a render-only check.
    it.each(LOCALE_CATALOGS)('%s carries the sentence with a {credits} slot', (_tag, catalog) => {
      const message = readPath(catalog, key);
      expect(typeof message).toBe('string');
      expect(message as string).toContain('{credits}');
    });

    it.each(LOCALE_CATALOGS)('%s names a whole amount without its stored decimals', (tag) => {
      const n = makeNotification({ type, payload: { ...payload, credits: '880.000000' } });
      expect(renderInLocale(tag, n)).toBe(
        REFUND_SENTENCES[tag][outcome].replace('{credits}', '880'),
      );
    });

    it.each(LOCALE_CATALOGS)('%s groups a large amount the way the locale groups it', (tag) => {
      // The grouping is whatever the shared credit formatter gives in this
      // locale (e.g. '12,500' in en), not a separator hard-coded here.
      const n = makeNotification({ type, payload: { ...payload, credits: '12500.000000' } });
      const text = renderInLocale(tag, n);
      expect(text).toBe(
        REFUND_SENTENCES[tag][outcome].replace('{credits}', formatCredits(12500, tag)),
      );
      expect(text).not.toContain('12500.000000');
    });
  });

  // inner#1410 v9 §8: `credit.refund_restored`, key
  // `notifications.headline.creditRefundRestored`. The design fixes the en and
  // zh-CN sentences; zh-TW, ja and ko follow the same structure, so for those
  // three this asserts the slot, the formatted amount and that the locale has
  // its own sentence rather than English.
  describe('credit.refund_restored in every shipped language', () => {
    const KEY = 'notifications.headline.creditRefundRestored';
    const EXACT: Partial<Record<LocaleTag, string>> = {
      en: '{credits} credits have been restored to your account',
      'zh-CN': '{credits} 积分已恢复到你的账号',
    };
    const restored = (credits: string) =>
      makeNotification({
        type: 'credit.refund_restored' as Notification['type'],
        payload: { lotId: 'lot-3', credits },
      });

    it.each(LOCALE_CATALOGS)('%s carries the sentence with a {credits} slot', (_tag, catalog) => {
      const message = readPath(catalog, KEY);
      expect(typeof message).toBe('string');
      expect(message as string).toContain('{credits}');
    });

    it.each(LOCALE_CATALOGS)('%s names a whole amount without its stored decimals', (tag) => {
      const text = renderInLocale(tag, restored('880.000000'));
      const exact = EXACT[tag];
      if (exact !== undefined) {
        expect(text).toBe(exact.replace('{credits}', '880'));
      } else {
        expect(text).toContain('880');
        expect(text).not.toContain('880.000000');
        expect(text).not.toBe(EXACT.en!.replace('{credits}', '880'));
        expect(text).not.toContain('credit.refund_restored');
      }
    });

    it.each(LOCALE_CATALOGS)('%s groups a large amount the way the locale groups it', (tag) => {
      const text = renderInLocale(tag, restored('12500.000000'));
      expect(text).toContain(formatCredits(12500, tag));
      expect(text).not.toContain('12500.000000');
    });
  });

  // A row with no usable `credits` follows membership.ended's missing tier:
  // the slot is filled with an empty string, so the sentence still renders
  // and no stand-in figure ('0', 'NaN', 'undefined') is ever shown as if it
  // were the amount. Number('') is 0, which is the easy way to get this wrong.
  describe.each([
    { type: 'credit.refund_completed' as const, key: 'notifications.headline.creditRefundCompleted' },
    { type: 'credit.refund_rejected' as const, key: 'notifications.headline.creditRefundRejected' },
    { type: 'credit.refund_restored' as Notification['type'], key: 'notifications.headline.creditRefundRestored' },
  ])('$type without a usable credits value', ({ type, key }) => {
    it.each([
      { label: 'missing', payload: { lotId: 'lot-3' } },
      { label: 'empty', payload: { lotId: 'lot-3', credits: '' } },
      { label: 'not a number', payload: { lotId: 'lot-3', credits: 'abc' } },
      { label: 'null', payload: { lotId: 'lot-3', credits: null } },
    ])('$label fills the slot with an empty string', ({ payload }) => {
      const seen: Array<Record<string, unknown> | undefined> = [];
      const tt = ((k: string, params?: Record<string, string | number | Date>) => {
        if (k === key) seen.push(params);
        return k === key ? `[${String(params?.credits)}] credits` : k;
      }) as ReturnType<typeof useTranslation>;
      const n = makeNotification({ type, payload });
      render(
        <MemoryRouter>
          <span data-testid='x'>
            {notificationHeadline(n, EMPTY_RESOLVED, tt)}
          </span>
        </MemoryRouter>,
      );
      expect(seen).toEqual([{ credits: '' }]);
      expect(screen.getByTestId('x').textContent).toBe('[] credits');
    });
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
