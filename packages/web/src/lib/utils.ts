import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
  return twMerge(clsx(inputs));
}
