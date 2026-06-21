import type { ComponentProps, ReactNode } from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '@web/lib/utils';

/**
 * Slider — a div-based range control (Radix UI). Renders identically across
 * browsers, unlike a native `<input type=range>` whose thumb shape differs per
 * engine (Safari capsule vs Chrome circle). Track / range / thumb inherit the
 * container's text colour via `currentColor`, so the same component works on a
 * dark video scrim (white text) and on a themed surface. Supports horizontal
 * and vertical orientation.
 * @param props - Radix `Slider.Root` props (`value` / `onValueChange`, `min`,
 *   `max`, `step`, `orientation`, `aria-label`, …).
 * @returns An accessible, draggable slider.
 */
export function Slider({
  className,
  orientation = 'horizontal',
  'aria-label': ariaLabel,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root>): ReactNode {
  const vertical = orientation === 'vertical';
  return (
    <SliderPrimitive.Root
      orientation={orientation}
      className={cn(
        'relative flex cursor-pointer touch-none select-none items-center',
        vertical ? 'h-full w-3 flex-col' : 'h-3 w-full',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        className={cn(
          'relative grow overflow-hidden rounded-full bg-current/25',
          vertical ? 'w-1' : 'h-1',
        )}
      >
        <SliderPrimitive.Range
          className={cn('absolute rounded-full bg-current', vertical ? 'w-full' : 'h-full')}
        />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        className='block size-3 rounded-full bg-current shadow-sm outline-none transition-transform hover:scale-110 focus-visible:ring-1 focus-visible:ring-ring'
      />
    </SliderPrimitive.Root>
  );
}
