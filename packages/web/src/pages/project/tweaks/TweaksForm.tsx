import * as React from 'react';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePreferencesStore } from '@/stores';
import { applyTweaks } from './apply-tweaks';

const TEXT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 12, label: 'Small (12)' },
  { value: 14, label: 'Normal (14)' },
  { value: 16, label: 'Large (16)' },
];

const RADIUS_OPTIONS = [
  { value: 'sharp', label: 'Sharp' },
  { value: 'round', label: 'Round' },
] as const;

const NEUTRALS_OPTIONS = [
  { value: 'warm-zinc', label: 'Warm zinc' },
  { value: 'cool-slate', label: 'Cool slate' },
] as const;

/**
 * Direction B 5-parameter tweaks form. Writes through to the preferences
 * store, then a local effect syncs the store state to runtime CSS vars via
 * `applyTweaks`. The 5 parameters: text scale · saturation · hue · radius
 * · neutrals (saturation + hue are number sliders, see future polish PR).
 */
export function TweaksForm() {
  const tweaks = usePreferencesStore((s) => s.tweaks);
  const setTweak = usePreferencesStore((s) => s.setTweak);

  React.useEffect(() => {
    applyTweaks(tweaks);
  }, [tweaks]);

  return (
    <div className='space-y-3' data-testid='tweaks-form'>
      <div>
        <Label htmlFor='tweak-text'>Text size</Label>
        <Select
          value={String(tweaks.textScale)}
          onValueChange={(v) => setTweak('textScale', Number(v))}
        >
          <SelectTrigger id='tweak-text'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEXT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={String(opt.value)}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor='tweak-radius'>Radius</Label>
        <Select
          value={tweaks.radius}
          onValueChange={(v) =>
            setTweak('radius', v as (typeof RADIUS_OPTIONS)[number]['value'])
          }
        >
          <SelectTrigger id='tweak-radius'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RADIUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor='tweak-neutrals'>Neutrals</Label>
        <Select
          value={tweaks.neutrals}
          onValueChange={(v) =>
            setTweak('neutrals', v as (typeof NEUTRALS_OPTIONS)[number]['value'])
          }
        >
          <SelectTrigger id='tweak-neutrals'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NEUTRALS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
