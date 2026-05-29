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

export function FieldError({
  id,
  children,
  className,
  role = 'status',
  ...rest
}: FieldErrorProps) {
  return (
    <p
      id={id}
      role={role}
      className={cn('text-sm leading-snug text-destructive', className)}
      {...rest}
    >
      {children}
    </p>
  );
}
