// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Clock, FileText, Palette } from 'lucide-react';
import * as React from 'react';

import { Label } from '@web/components/ui/label';
import { cn } from '@web/lib/utils';
import { SPACE_TYPE_LIST, type SpaceType } from '@web/spaces';
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
  /**
   * V1 only ships `canvas`; document + timeline are visually present but
   * disabled with a "not available" label per decision D (2026-05-21).
   * They are still plumbed end-to-end on the backend (B.2) so enabling
   * them later is a one-line `available: true` flip with no data change.
   */
  available: boolean;
}

const TYPE_CARDS: ReadonlyArray<TypeCardMeta> = [
  {
    type: 'canvas',
    icon: Palette,
    titleKey: 'spaces.kind.canvas',
    subtitleKey: 'spaces.kind.canvasSub',
    available: true,
  },
  {
    type: 'document',
    icon: FileText,
    titleKey: 'spaces.kind.document',
    subtitleKey: 'spaces.kind.documentSub',
    available: false,
  },
  {
    type: 'timeline',
    icon: Clock,
    titleKey: 'spaces.kind.timeline',
    subtitleKey: 'spaces.kind.timelineSub',
    available: false,
  },
];

/**
 * Shared, presentational 3-card segmented control for choosing a Space type
 * (canvas / document / timeline). Owned by the `spaces/` layer because it is
 * intrinsically about the space-type registry; the two create dialogs that
 * use it (project-page `NewSpaceDialog`, studio-page `NewItemDialog`) stay
 * separate components and only embed this one widget.
 *
 * Per decision D (2026-05-21): all three cards are visible so the product
 * roadmap is legible, but document + timeline are disabled with "not
 * available" until their editors ship — only canvas is selectable. The
 * `SPACE_TYPE_LIST` registry is consulted to surface only types the runtime
 * actually knows about (forward-compat against the registry pruning a type
 * the picker still lists).
 *
 * Mock alignment: mirrors the chrome-baseline mock `.type-segmented` — a flex
 * row of 3 cards; the active card uses the brand border on the mock, but per
 * ADR 14 brand-guard we use `border-active-border + bg-muted` (selected =
 * neutral recess + active border; hover uses bg-accent, so the two never collide).
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
  const registry = React.useMemo(
    () => new Set(SPACE_TYPE_LIST.map((s) => s.type)),
    [],
  );
  const cards = TYPE_CARDS.filter((c) => registry.has(c.type));

  return (
    <div className='flex flex-col gap-2'>
      <Label>{t('spaces.create.typeLabel')}</Label>
      <div
        className='flex gap-2'
        role='radiogroup'
        aria-label={t('spaces.create.typeAria')}
        data-testid={`${idPrefix}-segmented`}
      >
        {cards.map((card) => {
          const Icon = card.icon;
          const selected = value === card.type;
          return (
            <button
              key={card.type}
              type='button'
              role='radio'
              aria-checked={selected}
              aria-disabled={!card.available}
              disabled={!card.available}
              onClick={() => card.available && onChange(card.type)}
              data-testid={`${idPrefix}-${card.type}`}
              className={cn(
                'flex flex-1 flex-col items-center gap-2 rounded-chrome border px-3 py-3 text-center transition-colors',
                selected
                  ? 'border-active-border bg-accent text-foreground'
                  : 'border-border bg-transparent text-foreground',
                card.available
                  ? 'hover:bg-accent'
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
              <span className='text-2xs text-muted-foreground'>
                {t(card.subtitleKey)}
              </span>
              {!card.available ? (
                <span className='rounded-chrome bg-muted px-1 py-0.5 text-2xs font-medium text-muted-foreground'>
                  {t('spaces.create.notAvailable')}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
