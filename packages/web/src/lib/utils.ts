import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Register custom design-token radius keys with `tailwind-merge` so it
 * recognises them as part of the `borderRadius` group. Without this,
 * `cn('rounded-md', 'rounded-chrome')` would emit BOTH classes; the CSS
 * source order then decides which wins (here `.rounded-md` is generated
 * after `.rounded-chrome`, silently overriding the 6px chrome radius
 * with 12px — every chrome icon button visible regression).
 */
const customTwMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: [
        'chrome',
        'content-sm',
        'content-md',
        'content-lg',
        'content-xl',
      ],
    },
  },
});

/**
 * Combine class names with Tailwind conflict resolution.
 *
 * Wraps `clsx` (conditional class merging) + `tailwind-merge` (de-dup
 * conflicting Tailwind utilities, e.g. `px-2 px-4` → `px-4`). Used by every
 * shadcn primitive in `src/components/ui/`.
 *
 * @param inputs - Class values (strings / arrays / objects / falsy).
 * @returns Merged class name string with Tailwind conflicts resolved.
 */
export function cn(...inputs: ClassValue[]): string {
  return customTwMerge(clsx(inputs));
}
