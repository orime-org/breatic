import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind classNames with clsx semantics + tailwind-merge dedup.
 *
 * @param inputs - Class values (strings, conditionals, arrays, objects)
 * @returns Single merged className string with conflicting Tailwind classes deduped
 *
 * @example
 * cn("px-2 py-1", isActive && "bg-primary", { "text-foreground": !disabled })
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
