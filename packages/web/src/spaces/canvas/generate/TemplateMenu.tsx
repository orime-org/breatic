// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { LayoutTemplate } from 'lucide-react';
import * as React from 'react';

import {
  templatesFor,
  type GenerationNodeType,
  type GenerationTemplate,
} from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

interface TemplateMenuProps {
  /** The panel's node type: it lists only that type's templates. */
  nodeType: GenerationNodeType;
  /** The models this deployment serves for the node type. */
  models: readonly { name: string }[];
  /** Applies the picked template to the node. */
  onPick: (template: GenerationTemplate) => void;
}

/**
 * The template button in a generate panel's corner, left of the close button,
 * and the list of the node type's templates it opens (inner#977). A template
 * whose model this deployment lacks stays listed but cannot be picked.
 * @param root0 - Component props.
 * @param root0.nodeType - The panel's node type.
 * @param root0.models - The models this deployment serves for it.
 * @param root0.onPick - Applies the picked template.
 * @returns The button and its menu.
 */
export const TemplateMenu = React.memo(function TemplateMenu({
  nodeType,
  models,
  onPick,
}: TemplateMenuProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  useFollowCanvasViewport(open);
  const templates = templatesFor(nodeType);
  const served = React.useMemo(() => new Set(models.map((m) => m.name)), [models]);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type='button'
              variant={null}
              size={null}
              data-testid='generate-template-trigger'
              aria-label={t('canvas.template.title')}
              onFocusCapture={suppressTooltipFocusOpen}
              className='flex h-6 w-6 items-center justify-center rounded-overlay text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            >
              <LayoutTemplate className='h-3.5 w-3.5' aria-hidden='true' />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side='top'>{t('canvas.template.title')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align='end' avoidCollisions={false} className='w-72'>
        <DropdownMenuLabel>{t('canvas.template.title')}</DropdownMenuLabel>
        {templates.length === 0 ? (
          <p data-testid='generate-template-empty' className='px-2 py-1.5 text-sm text-muted-foreground'>
            {t('canvas.template.empty')}
          </p>
        ) : (
          templates.map((template) => {
            const available = served.has(template.model);
            return (
              <DropdownMenuItem
                key={template.id}
                data-testid={`generate-template-${template.id}`}
                disabled={!available}
                onSelect={() => onPick(template)}
                className='flex-col items-start gap-0.5'
              >
                <span className='flex w-full items-center justify-between gap-2'>
                  <span>{t(`canvas.template.${template.id}.name`)}</span>
                  {!available && (
                    <span className='text-xs text-muted-foreground'>{t('canvas.template.unavailable')}</span>
                  )}
                </span>
                <span className='text-xs text-muted-foreground'>
                  {t(`canvas.template.${template.id}.description`)}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
