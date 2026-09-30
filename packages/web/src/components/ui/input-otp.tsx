import * as React from 'react';
import { OTPInput, OTPInputContext } from 'input-otp';

import { cn } from '@web/lib/utils';

/**
 * One-time-code input (shadcn `input-otp`, over the `input-otp` package).
 *
 * A single real `<input>` sits under the slots, so typing, pasting a whole
 * code, deleting and the platform's "fill from mail / SMS" offer
 * (`autocomplete="one-time-code"`) all behave like a normal field. The slots
 * only draw what that input holds.
 *
 * Styled to match `Input`: 1px `border-border`, `rounded-chrome`, the active
 * slot takes `border-active-border`, and a slot given `aria-invalid` draws its
 * border in the error colour.
 * @param root0 - OTPInput props plus a class for the slot row
 * @param root0.className - classes for the underlying input
 * @param root0.containerClassName - classes for the row that holds the slots
 * @returns the code input.
 */
function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}): React.JSX.Element {
  return (
    <OTPInput
      data-slot='input-otp'
      containerClassName={cn(
        'flex items-center gap-2 has-[:disabled]:opacity-50',
        containerClassName,
      )}
      className={cn('disabled:cursor-not-allowed', className)}
      {...props}
    />
  );
}

/**
 * A row of slots.
 * @param root0 - div props
 * @param root0.className - extra classes
 * @returns the slot row.
 */
function InputOTPGroup({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot='input-otp-group'
      className={cn('flex items-center gap-2', className)}
      {...props}
    />
  );
}

/**
 * One character box, drawing what the hidden input holds at `index`.
 * @param root0 - div props plus the slot's position
 * @param root0.index - which character of the code this box shows
 * @param root0.className - extra classes
 * @returns the slot.
 */
function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<'div'> & { index: number }): React.JSX.Element {
  const context = React.useContext(OTPInputContext);
  const slot = context.slots[index];
  const isActive = slot?.isActive ?? false;
  return (
    <div
      data-slot='input-otp-slot'
      data-active={isActive}
      className={cn(
        'relative flex h-12 w-11 items-center justify-center rounded-chrome border border-border bg-transparent',
        'font-mono text-xl font-semibold text-foreground transition-colors',
        'data-[active=true]:border-active-border',
        'aria-invalid:border-status-error-foreground aria-invalid:data-[active=true]:border-status-error-foreground',
        className,
      )}
      {...props}
    >
      {slot?.char}
      {slot?.hasFakeCaret ? (
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <div className='h-5 w-px animate-pulse bg-foreground' />
        </div>
      ) : null}
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot };
