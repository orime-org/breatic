// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Download, FileImage, FileJson, FileText } from 'lucide-react';
import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';

const EXPORT_FORMATS = [
  { id: 'png', labelKey: 'chrome.export.png', icon: FileImage },
  { id: 'pdf', labelKey: 'chrome.export.pdf', icon: FileText },
  { id: 'json', labelKey: 'chrome.export.json', icon: FileJson },
] as const;

/**
 * Export menu — popover with the supported export formats. Actually
 * triggering the export goes through `data/api/canvas.ts` in a later PR;
 * here we just register click handlers so the chrome wires up.
 * @param root0 - Export menu props.
 * @param root0.onExport - Called with the chosen format id (`png` / `pdf` / `json`) when a menu item is clicked.
 * @returns the export toolbar button with a popover listing the supported formats.
 */
export function ExportMenu({
  onExport,
}: {
  onExport?: (format: string) => void;
}): React.JSX.Element {
  const t = useTranslation();
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant='chrome-ghost' size='chrome' aria-label={t('chrome.tooltip.export')}>
              <Download className='h-[18px] w-[18px]' />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side='bottom'>{t('chrome.tooltip.export')}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align='end'
        className='w-56 p-1'
        data-testid='export-popover'
      >
        <div className='flex flex-col gap-0.5'>
          {EXPORT_FORMATS.map((f) => {
            const ItemIcon = f.icon;
            return (
              <Button
                key={f.id}
                variant='ghost'
                size='menu-item'
                className='justify-start'
                onClick={() => onExport?.(f.id)}
              >
                <ItemIcon className='h-4 w-4' />
                {t(f.labelKey)}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
