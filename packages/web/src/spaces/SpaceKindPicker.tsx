// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Clock, FileText, Palette } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
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
  titleKey: 'spaces.kind.canvas' | 'spaces.kind.document' | 'spaces.kind.timeline';
  subtitleKey:
    | 'spaces.kind.canvasSub'
    | 'spaces.kind.documentSub'
    | 'spaces.kind.timelineSub';
}

const TYPE_CARDS: ReadonlyArray<TypeCardMeta> = [
  {
    type: 'canvas',
    icon: Palette,
    titleKey: 'spaces.kind.canvas',
    subtitleKey: 'spaces.kind.canvasSub',
  },
  {
    type: 'document',
    icon: FileText,
    titleKey: 'spaces.kind.document',
    subtitleKey: 'spaces.kind.documentSub',
  },
  {
    type: 'timeline',
    icon: Clock,
    titleKey: 'spaces.kind.timeline',
    subtitleKey: 'spaces.kind.timelineSub',
  },
];

/**
 * Shared, presentational 3-card segmented control for choosing a Space type
 * (canvas / document / timeline). Owned by the `spaces/` layer because it is
 * intrinsically about the space-type registry; the two create dialogs that
 * use it (project-page `NewSpaceDialog`, studio-page `NewItemDialog`) stay
 * separate components and only embed this one widget.
 *
 * Each card's `type` is a `SpaceType`, validated by `SpaceTypeSchema` on the API, so a
 * card naming a type the system does not accept fails to compile.
 *
 * Mock alignment: mirrors the chrome-baseline mock `.type-segmented` — a flex
 * row of 3 cards; the active card uses the brand border on the mock, but per
 * ADR 14 brand-guard we use `border-active-border + bg-accent-strong` — the
 * chosen card fills one step past the fill the other two take under the
 * pointer, so the three never read alike.
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
        className='flex gap-2'
        role='radiogroup'
        aria-label={t('spaces.create.typeAria')}
        data-testid={`${idPrefix}-segmented`}
      >
        {TYPE_CARDS.map((card) => {
          const Icon = card.icon;
          const selected = value === card.type;
          return (
            <Button
              key={card.type}
              variant={null}
              // `menu-item` is the only auto-height size — the card stacks an
              // icon over two text lines, so a fixed `h-*` size would clip it.
              size={null}
              type='button'
              role='radio'
              aria-checked={selected}
              onClick={() => onChange(card.type)}
              data-testid={`${idPrefix}-${card.type}`}
              className={cn(
                'flex flex-1 flex-col items-center gap-2 rounded-chrome border px-3 py-3 text-center transition-colors',
                selected
                  ? 'border-active-border bg-accent-strong text-foreground'
                  : 'border-border bg-transparent text-foreground',
                // The picked card keeps its own fill under the pointer: plain
                // hover outranks it and would drop it to the fill the other
                // two take, leaving the three reading alike.
                selected ? 'hover-enabled:bg-accent-strong' : 'hover-enabled:bg-accent',
              )}
            >
              <Icon
                className={cn(
                  'h-7 w-7',
                  selected ? 'text-foreground' : 'text-muted-foreground',
                )}
              />
              <span className='text-sm font-medium'>{t(card.titleKey)}</span>
              <span className='text-2xs text-muted-foreground'>
                {t(card.subtitleKey)}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
