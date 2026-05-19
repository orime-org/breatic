import { Sliders } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { TweaksForm } from '@/pages/project/tweaks/TweaksForm';

/**
 * Top-bar entry to the Direction B 5-parameter tweaks (text size,
 * saturation, hue, radius, neutrals). Opens a popover hosting `TweaksForm`,
 * which writes through to `usePreferencesStore` + runtime CSS-var injection.
 */
export function TweaksPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant='ghost' size='icon' aria-label='Tweaks'>
          <Sliders className='h-4 w-4' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-80' align='end' data-testid='tweaks-popover'>
        <TweaksForm />
      </PopoverContent>
    </Popover>
  );
}
