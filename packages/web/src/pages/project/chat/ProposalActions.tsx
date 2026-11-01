// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button, type ButtonProps } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';

/**
 * The row a proposal card's land buttons sit in, for the Canvas and the
 * Document card alike (inner#1602). 270px is the card's inner width at the
 * narrowest Agent column, so the row fills the card there and stops growing
 * as the column widens (inner#1372); its buttons share it equally. A row of
 * three, on the Document card, wraps whole buttons onto a second line when a
 * language's words do not fit side by side (inner#1646).
 * @param props - The buttons.
 * @param props.children - One or more {@link ProposalAction}s.
 * @param props.wrap - Whether whole buttons wrap rather than squeeze.
 * @returns The row.
 * @throws {never} Never.
 */
export function ProposalActions({ children, wrap = false }: { children: React.ReactNode; wrap?: boolean }): React.JSX.Element {
  return <div className={cn('flex w-full max-w-[270px] gap-2 self-center', wrap && 'flex-wrap *:min-w-max')}>{children}</div>;
}

/**
 * One land button on a proposal card.
 * @param props - Any button props; type, variant and size are fixed.
 * @returns The button.
 * @throws {never} Never.
 */
export const ProposalAction = React.forwardRef<HTMLButtonElement, ButtonProps>(function ProposalAction(
  { className, ...props },
  ref,
): React.JSX.Element {
  return <Button ref={ref} type='button' variant='outline' size='form' className={cn('flex-1', className)} {...props} />;
});
