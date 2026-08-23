// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * An entry on the bubble bar whose command is not open yet.
 *
 * The entry stands in the bar so the shape is whole from the first slice —
 * user 2026-08-23: "even with no function behind it, leave the shell there,
 * leave an empty entry there". What it must not do is look usable: a control
 * that reads as available and answers a click with nothing tells the reader
 * it is broken.
 *
 * The treatment follows the two snapshot commands in the whole-document menu
 * (`ComingEntry`, `StudioAccountMenu.tsx:99-119`): dimmed, `aria-disabled`,
 * a cursor that says so, and nothing happens on click. Two things differ,
 * both because this is an icon button on a floating bar rather than a row in
 * a menu — there is no room beside the icon for the badge that carries the
 * reason, so the reason rides on the tooltip and the accessible name; and the
 * bar stays out of the tab order entirely (ruling R4), so this does too.
 *
 * `aria-disabled` rather than HTML `disabled`: the first leaves the entry in
 * the accessibility tree to be read, the second drops it out.
 */

import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';

/** An entry whose command has no implementation behind it yet. */
export interface ComingToolDef {
  /** Stable id, used for the test id. */
  id: string;
  /** i18n key for the command's name. */
  labelKey: string;
  /** The icon the demo draws for it. */
  Icon: LucideIcon;
}

interface ComingToolProps {
  tool: ComingToolDef;
}

/**
 * Renders one not-open-yet entry.
 * @param props - The entry to render.
 * @returns The entry button.
 */
export const ComingTool = React.memo(function ComingTool({
  tool,
}: ComingToolProps): React.JSX.Element {
  const t = useTranslation();
  // One string carries both the name and the reason, so the two never drift
  // apart and each language keeps its own punctuation.
  const label = t('spaces.document.commands.comingLabel', {
    name: t(tool.labelKey),
  });
  const Icon = tool.Icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          aria-disabled='true'
          aria-label={label}
          data-testid={`doc-bubble-coming-${tool.id}`}
          onClick={(event) => event.preventDefault()}
          tabIndex={-1}
          className='h-[26px] w-7 cursor-not-allowed opacity-50'
        >
          <Icon className='h-4 w-4' />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});
