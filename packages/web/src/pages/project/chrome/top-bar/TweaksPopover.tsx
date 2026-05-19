import { SlidersHorizontal } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { TweaksForm } from '@/pages/project/tweaks/TweaksForm';
import { TopBarTextIconButton } from './TopBarTextIconButton';

/**
 * Top-bar entry to the Direction B 5-parameter tweaks. Renders as a
 * text-icon TopBar button (mock § TopBar v4.0 group A), opens a popover
 * hosting `TweaksForm` which writes through to `usePreferencesStore`.
 */
export function TweaksPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <TopBarTextIconButton
          aria-label='Tweaks'
          data-testid='tweaks-trigger'
          icon={<SlidersHorizontal className='h-[18px] w-[18px]' />}
        >
          Tweaks
        </TopBarTextIconButton>
      </PopoverTrigger>
      <PopoverContent className='w-80' align='end' data-testid='tweaks-popover'>
        <TweaksForm />
      </PopoverContent>
    </Popover>
  );
}
