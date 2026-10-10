// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import * as Sentry from '@sentry/react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale, type Locale } from '@breatic/shared';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { ApplicationErrorPage } from '../../components/application-error-page';

afterEach(async () => {
  await Sentry.close();
  vi.restoreAllMocks();
  setLocale('en');
});

describe('application recovery', () => {
  it('captures an outer effect exception once without exposing its text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn<ReturnType<NonNullable<Sentry.BrowserOptions['transport']>>['send']>(async () => ({ statusCode: 200 }));
    Sentry.init({ dsn: 'https://public@sentry.invalid/1', defaultIntegrations: false,
      transport: () => ({ send, flush: async () => true }) });
    const error = new Error('Private component failure');
    function Broken(): React.JSX.Element {
      React.useEffect(() => { throw error; }, []);
      return <div>Never usable</div>;
    }
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    expect(await screen.findByText('Something went wrong')).toBeVisible();
    expect(screen.queryByText(error.message)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
    await Sentry.flush(2000);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const event = send.mock.calls[0]?.[0]?.[1]?.[0]?.[1];
    expect(event).toMatchObject({ tags: { error_boundary: 'application' } });
    expect(screen.getByText(/^Error reference:/)).toHaveTextContent(Sentry.lastEventId()!);
  });

  it('keeps recovery usable without a configured SDK or application providers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): React.JSX.Element { throw new Error('No configured client'); }
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    expect(await screen.findByText('Something went wrong')).toBeVisible();
    expect(screen.queryByText(/^Error reference:/)).not.toBeInTheDocument();
  });

  it.each<[Locale, string, string]>([
    ['en', 'Something went wrong', 'Reload page'],
    ['zh-CN', '页面出现了问题', '重新加载'],
    ['zh-TW', '頁面發生了問題', '重新載入'],
    ['ja', '問題が発生しました', '再読み込み'],
    ['ko', '문제가 발생했습니다', '새로고침'],
  ])('localizes recovery in %s', (locale, title, reload) => {
    setLocale(locale);
    render(<ApplicationErrorPage />);
    expect(screen.getByRole('heading', { name: title })).toBeVisible();
    expect(screen.getByRole('button', { name: reload })).toBeEnabled();
  });
});
