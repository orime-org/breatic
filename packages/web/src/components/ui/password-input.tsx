import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@web/components/ui/input';
import { cn } from '@web/lib/utils';

/**
 * Input variant for passwords — adds a right-side icon button that
 * toggles `type="password"` / `type="text"`. Standard auth field
 * affordance (GitHub / Linear / 1Password). Keeps Input's
 * `aria-invalid` red-border state so field-level inline errors still
 * surface the same way as text/email fields.
 *
 * Pass-through:
 *   - All native `<input>` props go to the underlying Input.
 *   - `className` extends the Input's classes (right padding for the
 *     toggle is added internally so callers don't need to know).
 *
 * Accessibility:
 *   - Toggle button is `aria-label`'d with show/hide copy from i18n.
 *   - `aria-pressed` reflects whether the password is currently visible.
 *   - Button is `type="button"` so it never submits the surrounding form.
 */
interface PasswordInputProps
  extends Omit<React.ComponentProps<'input'>, 'type'> {
  /** Label for the show toggle (i18n). Default English fallback. */
  showLabel?: string;
  /** Label for the hide toggle (i18n). Default English fallback. */
  hideLabel?: string;
}

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, showLabel = 'Show password', hideLabel = 'Hide password', ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    return (
      <div className='relative'>
        <Input
          {...props}
          ref={ref}
          type={visible ? 'text' : 'password'}
          // Reserve right padding so the toggle button doesn't overlap
          // text. 36px = 24px button width + 6px gap on each side.
          className={cn('pr-9', className)}
        />
        <button
          type='button'
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          tabIndex={-1}
          className={cn(
            'absolute top-1/2 right-2 -translate-y-1/2',
            'inline-flex h-6 w-6 items-center justify-center rounded-sm',
            'text-muted-foreground transition-colors',
            'hover:text-foreground focus-visible:text-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          {visible ? (
            <EyeOff className='h-4 w-4' aria-hidden />
          ) : (
            <Eye className='h-4 w-4' aria-hidden />
          )}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
