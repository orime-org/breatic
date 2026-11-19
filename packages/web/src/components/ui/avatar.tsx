import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Avatar — circular user portrait backed by @radix-ui/react-avatar.
 *
 * Composed of three parts:
 *   - `<Avatar>`         : root container (size, shape, overflow clipping)
 *   - `<AvatarImage>`    : actual `<img>`; auto-hidden if `src` fails to load
 *   - `<AvatarFallback>` : shown while the image is loading or after failure
 *
 * The Radix root manages a small state machine so the fallback flashes only
 * after a loading delay (configurable via `<AvatarFallback delayMs={...}>`).
 *
 * Default size: 40px (`h-10 w-10`); override via `className` on root.
 *
 * A picture gets a 1px inset edge in the border colour, drawn over it, so a
 * light picture still shows its outline on a light surface. Initials keep
 * their own fill and no edge.
 */
const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full',
      'has-[img]:after:pointer-events-none has-[img]:after:absolute has-[img]:after:inset-0 has-[img]:after:rounded-[inherit] has-[img]:after:ring-1 has-[img]:after:ring-inset has-[img]:after:ring-border',
      className,
    )}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn('aspect-square h-full w-full', className)}
    {...props}
  />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      'flex h-full w-full items-center justify-center rounded-full bg-muted',
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
