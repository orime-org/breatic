import * as React from 'react';
import { Link } from 'react-router-dom';

/**
 * Shared frame for every auth page (login / register / forgot /
 * reset / verify).
 *
 * Renders a centered card on the project background — same surface
 * tokens as the rest of the app so a redirect from `/studio` to
 * `/login` feels seamless. Title + optional subtitle sit in a tight
 * header above the form body; a footer slot below carries
 * cross-links ("Don't have an account? Sign up" etc.).
 */
interface AuthCardShellProps {
  title: string;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function AuthCardShell({
  title,
  subtitle,
  footer,
  children,
}: AuthCardShellProps) {
  return (
    <main className='flex min-h-screen items-center justify-center bg-background p-6'>
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
      </div>
    </main>
  );
}

/** Convenience link for the auth footer ("Sign up" / "Sign in" etc.). */
export function AuthLink({
  to,
  children,
}: {
  to: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className='font-medium text-foreground underline-offset-4 hover:underline'
    >
      {children}
    </Link>
  );
}
