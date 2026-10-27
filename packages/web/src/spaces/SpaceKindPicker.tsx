// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Box, Clock, FileText, Palette } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';
import { type SpaceType } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';

interface SpaceKindPickerProps {
  /** The currently selected space type. */
  value: SpaceType;
  /** Called with the chosen type when an available card is clicked. */
  onChange: (type: SpaceType) => void;
  /**
   * Prefix for the cards' `data-testid` + radiogroup test id, so the two
   * dialogs that embed this picker (new-space on the project page,
   * new-project on the studio page) get non-colliding hooks. Defaults to
   * `space-kind`.
   */
  idPrefix?: string;
}

interface TypeCardMeta {
  type: SpaceType;
  icon: typeof Palette;
  titleKey: 'spaces.kind.canvas' | 'spaces.kind.document' | 'spaces.kind.timeline' | 'spaces.kind.threeD';
  descriptionKey: 'spaces.kind.canvasSub' | 'spaces.kind.documentSub' | 'spaces.kind.timelineSub' | 'spaces.kind.threeDSub';
  /** Whether this type's editor can be opened. */
  available: boolean;
}

const TYPE_CARDS: ReadonlyArray<TypeCardMeta> = [
  {
    type: 'canvas',
    icon: Palette,
    titleKey: 'spaces.kind.canvas',
    descriptionKey: 'spaces.kind.canvasSub',
    available: true,
  },
  {
    type: 'document',
    icon: FileText,
    titleKey: 'spaces.kind.document',
    descriptionKey: 'spaces.kind.documentSub',
    available: true,
  },
  { type: '3d', icon: Box, titleKey: 'spaces.kind.threeD', descriptionKey: 'spaces.kind.threeDSub', available: true },
  {
    type: 'timeline',
    icon: Clock,
    titleKey: 'spaces.kind.timeline',
    descriptionKey: 'spaces.kind.timelineSub',
    available: false,
  },
];

/**
 * The Project and Space creation dialogs share this control so type labels,
 * ordering and availability stay consistent across both entry points.
 * @param root0 - Component props.
 * @param root0.value - The currently selected space type.
 * @param root0.onChange - Called with the chosen type when an available card is clicked.
 * @param root0.idPrefix - Prefix for the cards' + group's `data-testid`.
 * @returns The labelled space-type segmented control.
 */
export function SpaceKindPicker({
  value,
  onChange,
  idPrefix = 'space-kind',
}: SpaceKindPickerProps): React.JSX.Element {
  const t = useTranslation();

  return (
    <div className='flex flex-col gap-2'>
      <Label>{t('spaces.create.typeLabel')}</Label>
      <div
        className='grid grid-cols-4 gap-2'
        role='radiogroup'
        aria-label={t('spaces.create.typeAria')}
        data-testid={`${idPrefix}-segmented`}
      >
        {TYPE_CARDS.map((card) => {
          const Icon = card.icon;
          const selected = value === card.type;
          const option = (
            <Button
              key={card.type}
              variant={null}
              // The stacked icon and name determine the card's height.
              size={null}
              type='button'
              role='radio'
              aria-checked={selected}
              aria-disabled={!card.available}
              aria-label={!card.available ? `${t(card.titleKey)} (${t('spaces.create.notAvailable')})` : undefined}
              onClick={card.available ? () => onChange(card.type) : undefined}
              data-testid={`${idPrefix}-${card.type}`}
              className={cn(
                'flex w-full min-w-0 flex-col items-center gap-2 rounded-chrome border px-3 py-3 text-center transition-colors',
                selected
                  ? 'border-active-border bg-accent-strong text-foreground'
                  : 'border-border bg-transparent text-foreground',
                // The picked card keeps its own fill under the pointer: plain
                // hover outranks it and would drop it to the fill the other
                // two take, leaving the three reading alike.
                card.available
                  ? selected
                    ? 'hover:bg-accent-strong'
                    : 'hover:bg-accent'
                  : 'cursor-not-allowed opacity-50',
              )}
            >
              <Icon
                className={cn(
                  'h-7 w-7',
                  selected ? 'text-foreground' : 'text-muted-foreground',
                )}
              />
              <span className='text-sm font-medium'>{t(card.titleKey)}</span>
            </Button>
          );
          return (
            <Tooltip key={card.type}>
              <div className='relative min-w-0'>
                <TooltipTrigger asChild>{option}</TooltipTrigger>
                {card.type === '3d' ? (
                  <Badge variant='secondary' className='pointer-events-none absolute right-1 top-1 px-1 py-0 text-2xs font-medium'>
                    {t('spaces.kind.developmentBadge')}
                  </Badge>
                ) : null}
              </div>
              <TooltipContent>{t(card.descriptionKey)}{!card.available ? ` · ${t('spaces.create.notAvailable')}` : null}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
