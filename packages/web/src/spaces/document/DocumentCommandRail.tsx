// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The column at the body's right edge: commands whose object is the WHOLE
 * document.
 *
 * The routing rule behind it (design §3.0): a command goes to the carrier that
 * matches what it acts on. Selection and block commands have their own
 * carriers; whole-document ones had none once the top bar went away, and this
 * column is where they landed. Export, document settings and a button for
 * `clearDocument` all belong here when they arrive.
 *
 * It floats over the body rather than taking a column of its own — the body
 * has a max width and sits centred, so the gutter is already there.
 */

import { Camera, History } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';

/** One not-yet-open command in the rail. */
interface RailEntry {
  id: string;
  labelKey: string;
  Icon: typeof Camera;
}

const ENTRIES: readonly RailEntry[] = [
  {
    id: 'save-snapshot',
    labelKey: 'spaces.document.rail.saveSnapshot',
    Icon: Camera,
  },
  {
    id: 'restore-snapshot',
    labelKey: 'spaces.document.rail.restoreSnapshot',
    Icon: History,
  },
];

/**
 * A rail button for a command that is not open yet.
 *
 * Follows `ComingEntry` (`StudioAccountMenu.tsx:99-119`): dimmed, announced as
 * disabled, inert on click. The HTML `disabled` attribute is deliberately not
 * used — it takes the button out of the focus order, and a control that people
 * are meant to discover has to stay in it. The note `ComingEntry` shows beside
 * its label has no room on a 32px icon button, so a tooltip carries it.
 * @param root0 - Entry props.
 * @param root0.entry - Which command this button stands for.
 * @returns The button, wrapped in its tooltip.
 */
function ComingRailButton({ entry }: { entry: RailEntry }): React.JSX.Element {
  const t = useTranslation();
  const Icon = entry.Icon;
  const label = t(entry.labelKey);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          aria-label={label}
          aria-disabled='true'
          data-testid={`doc-rail-${entry.id}`}
          onClick={(event) => event.preventDefault()}
          className='h-8 w-8 cursor-not-allowed opacity-50'
        >
          <Icon className='h-4 w-4' />
        </Button>
      </TooltipTrigger>
      <TooltipContent side='left'>
        {t('spaces.document.rail.notOpenYet')}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The whole-document command column.
 * @returns The rail.
 */
export const DocumentCommandRail = React.memo(
  function DocumentCommandRail(): React.JSX.Element {
    return (
      <div
        data-testid='doc-command-rail'
        className='pointer-events-none absolute top-5 right-4 z-10 flex flex-col gap-2'
      >
        {ENTRIES.map((entry) => (
          <div key={entry.id} className='pointer-events-auto'>
            <ComingRailButton entry={entry} />
          </div>
        ))}
      </div>
    );
  },
);
