// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Wand2 } from 'lucide-react';
import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { miniToolsForModality } from '@web/pages/project/mini-tool-system/catalog';
import type { Modality } from '@web/spaces/canvas/types/node-view';

interface MiniToolPickerProps {
  modality: Modality;
  onPick?: (toolId: string) => void;
}

/**
 * Right-zone "Mini-tool" entry on the node toolbar. Opens a popover with
 * tools filtered by the modality. Selecting a tool creates a NEW sibling
 * node + primary edge (ADR mini-tool-unified-output) — the current node
 * is never mutated.
 *
 * Tools come from the catalog in `pages/project/mini-tool-system/`.
 * @param root0 - Mini-tool picker props.
 * @param root0.modality - Active node's modality, used to filter the available tools.
 * @param root0.onPick - Called with the chosen tool id; the page creates a new sibling node + edge.
 * @returns The mini-tool trigger button and its popover.
 */
export function MiniToolPicker({
  modality,
  onPick,
}: MiniToolPickerProps): React.JSX.Element {
  const tools = miniToolsForModality(modality);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='ghost'
          size='sm'
          className='h-7 gap-1 px-2'
          data-testid='mini-tool-trigger'
        >
          <Wand2 className='h-3.5 w-3.5' />
          <span className='text-xs'>Mini-tool</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-56 p-1'
        data-testid='mini-tool-popover'
      >
        {/* Native scroller (#1773): the global thin overlay scrollbar
            (index.css) — one scrollbar look repo-wide. */}
        <div className='max-h-64 overflow-y-auto'>
          <div className='flex flex-col gap-0.5 pr-2'>
            {tools.map((t) => (
              <Button
                key={t.id}
                variant='ghost'
                size='menu-item'
                className='justify-between'
                onClick={() => onPick?.(t.id)}
                data-testid={`mini-tool-${t.id}`}
              >
                <span>{t.label}</span>
                <span className='text-2xs uppercase text-muted-foreground'>
                  {t.output}
                </span>
              </Button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
