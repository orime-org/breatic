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
 * a cursor that says so, and nothing happens on click. Three things differ,
 * all three because this is a button on a floating bar rather than a row in
 * a menu — there is no room beside the icon for the badge that carries the
 * reason, so the reason rides on the tooltip and the accessible name; and the
 * bar stays out of the tab order entirely (ruling R4), so this does too; and
 * the hover highlight is switched off here in CSS, where the menu row does it
 * by cancelling `onPointerMove` (that cancel has no effect on a `:hover`
 * rule). Hovering is the gesture that makes the promise, and it is the one
 * that has to be withdrawn.
 *
 * `aria-disabled` rather than HTML `disabled`: the first leaves the entry in
 * the accessibility tree to be read, the second drops it out.
 */

import { ChevronDown, type LucideIcon } from 'lucide-react';
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
  /**
   * Draws the shape the demo gives a menu opener: icon, label, chevron
   * (`.bubble-drop`), rather than a bare icon button (`.bubble-btn`). The AI
   * entry is drawn this way — it opens onto a list of commands, and the demo
   * says so on its face.
   */
  opensAMenu?: boolean;
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
          size={tool.opensAMenu ? null : 'icon'}
          aria-disabled='true'
          aria-label={label}
          data-testid={`doc-bubble-coming-${tool.id}`}
          onClick={(event) => event.preventDefault()}
          tabIndex={-1}
          className={
            tool.opensAMenu
              // `.bubble-drop`: 26 tall, 6px either side, 3px between the
              // three things in it. The demo draws 13px text; the size comes
              // from the button's own `text-sm` instead, which is the token
              // every other label on the bar reads.
              ? 'flex h-[26px] items-center gap-[3px] px-1.5 hover:bg-transparent hover:text-current cursor-not-allowed opacity-50'
              : 'h-[26px] w-7 hover:bg-transparent hover:text-current cursor-not-allowed opacity-50'
          }
        >
          <Icon className='h-4 w-4' />
          {tool.opensAMenu ? (
            <>
              {t(tool.labelKey)}
              <ChevronDown className='h-[13px] w-[13px]' />
            </>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});
