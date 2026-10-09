// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';

import { LangSwitcher } from '@web/features/preferences/LangSwitcher';
import { ThemeToggle } from '@web/features/preferences/ThemeToggle';
import { useTranslation } from '@web/i18n/use-translation';
import { PRIVACY_URL, TERMS_URL } from '@web/lib/official-home';
import { BrandHomeLink } from '@web/ui/BrandHomeLink';
import { TopBar } from '@web/ui/TopBar';

/** Links in the page footer: muted until hovered, with the app's focus ring. */
const FOOTER_LINK_CLASS =
  'rounded-chrome-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/**
 * Shared frame for the sign-in, sign-up and account-recovery pages and the
 * signed-in pages that look like them (slug setup, decision landing).
 *
 * A page header (brand, language, theme) and a page footer (terms,
 * privacy) around a centered card on the project background — same
 * surface tokens as the rest of the app so a redirect from `/studio` to
 * `/login` feels seamless. In the card, title + optional subtitle sit in a
 * tight header above the form body; a footer slot below carries
 * cross-links ("Don't have an account? Sign up" etc.).
 */
interface AuthCardShellProps {
  title: string;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  /** A line under the footer — the terms line on the sign-in and sign-up cards. */
  notice?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Auth page: page header, a centered card framing a form with a title, body,
 * and footer, then the page footer.
 * @param root0 - component props
 * @param root0.title - heading shown at the top of the card
 * @param root0.subtitle - optional supporting line beneath the title
 * @param root0.footer - optional footer slot for cross-page links
 * @param root0.notice - optional line rendered under the footer
 * @param root0.children - the form (or other body content) inside the card
 * @returns the page header, the centered auth card, and the page footer.
 */
export function AuthCardShell({
  title,
  subtitle,
  footer,
  notice,
  children,
}: AuthCardShellProps): React.JSX.Element {
  return (
    <div className='flex min-h-screen flex-col bg-background'>
      <AuthPageHeader />
      <main className='flex flex-1 items-center justify-center p-6'>
        <div className='w-full max-w-sm rounded-overlay border border-border bg-card p-6 text-card-foreground shadow-sm'>
          <header className='mb-4 flex flex-col gap-1'>
            <h1 className='text-xl font-semibold tracking-tight'>{title}</h1>
            {subtitle ? (
              <p className='text-sm text-muted-foreground'>{subtitle}</p>
            ) : null}
          </header>
          {children}
          {footer ? (
            <footer className='mt-6 text-center text-sm text-muted-foreground'>
              {footer}
            </footer>
          ) : null}
          {notice}
        </div>
      </main>
      <AuthPageFooter />
    </div>
  );
}

/**
 * The page header above the card, on the Studio's top bar: the brand on the
 * left, the language and theme switches on the right.
 * @returns the page header.
 */
function AuthPageHeader(): React.JSX.Element {
  return (
    <TopBar testId='auth-page-header'>
      <BrandHomeLink />
      <div className='flex items-center gap-1'>
        <LangSwitcher />
        <ThemeToggle />
      </div>
    </TopBar>
  );
}

/**
 * The page footer below the card: the terms and the privacy policy on the
 * official website, each in a new tab so the form keeps what was typed.
 * @returns the page footer.
 */
function AuthPageFooter(): React.JSX.Element {
  const t = useTranslation();
  return (
    <footer
      data-testid='auth-page-footer'
      className='flex shrink-0 justify-center gap-4 py-4 text-xs text-muted-foreground'
    >
      <a href={TERMS_URL} target='_blank' rel='noreferrer' className={FOOTER_LINK_CLASS}>
        {t('auth.terms.termsLink')}
      </a>
      <a href={PRIVACY_URL} target='_blank' rel='noreferrer' className={FOOTER_LINK_CLASS}>
        {t('auth.terms.privacyLink')}
      </a>
    </footer>
  );
}

/**
 * Convenience link for the auth footer ("Sign up" / "Sign in" etc.).
 * @param root0 - component props
 * @param root0.to - the route path the link navigates to
 * @param root0.children - the visible link text
 * @returns an underline-on-hover router link styled for the auth footer.
 */
export function AuthLink({
  to,
  children,
}: {
  to: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      className='rounded-chrome-sm text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
    >
      {children}
    </Link>
  );
}
