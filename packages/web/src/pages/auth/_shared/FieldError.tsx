// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { cn } from '@web/lib/utils';

/**
 * Inline field error line — rendered immediately below an Input to
 * surface validation problems tied to that field. Pairs with the
 * Input's `aria-invalid` red border so the cue is both color and
 * text (a11y AA + zero eye-movement vs. a top-of-page toast).
 *
 * Form-wide async errors (server 5xx, network drop) can reuse this
 * component above the submit button by passing `role='alert'`.
 */
interface FieldErrorProps extends React.HTMLAttributes<HTMLParagraphElement> {
  /** Optional id — when set, mirror in the Input's `aria-describedby`. */
  id?: string;
  children: React.ReactNode;
  className?: string;
  /** Defaults to `status` (a11y polite); pass `alert` for form-wide. */
  role?: 'status' | 'alert';
}

/**
 * Accessible inline error paragraph wired as an aria live region.
 * @param root0 - component props (plus any extra paragraph attributes)
 * @param root0.id - optional id to mirror in the Input's `aria-describedby`
 * @param root0.children - the error message text
 * @param root0.className - extra classes appended to the base styling
 * @param root0.role - live-region role; `status` (polite) by default, `alert` for form-wide errors
 * @returns a styled error paragraph wired as an accessible live region.
 */
export function FieldError({
  id,
  children,
  className,
  role = 'status',
  ...rest
}: FieldErrorProps): React.JSX.Element {
  return (
    <p
      id={id}
      role={role}
      className={cn('text-sm leading-snug text-status-error-foreground', className)}
      {...rest}
    >
      {children}
    </p>
  );
}
