// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { LayoutTemplate } from 'lucide-react';
import * as React from 'react';

import {
  getLocale,
  templateGoalsFor,
  templateStyleKey,
  templateStylesOf,
  type GenerationNodeType,
  type GenerationTemplate,
  type TemplateStyleSet,
} from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrailing,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { cn } from '@web/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { ensureTemplateStyleMessages } from '@web/spaces/canvas/generate/template-style-messages';
import { templateServed } from '@web/spaces/canvas/generate/template-writes';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

interface TemplateMenuProps {
  /** The panel's node type: it lists only that type's templates. */
  nodeType: GenerationNodeType;
  /** Every model this deployment serves, across node types: a template's nodes can run in several. */
  models: readonly { name: string }[];
  /** Applies the picked template to the node, with the style picked for a styled one (inner#1817). */
  onPick: (template: GenerationTemplate, style?: string) => void;
}

/** Where the style words of the menu's locale stand. */
type StyleWordsState = 'loading' | 'ready' | 'failed';

interface TemplateStyleChoicesProps {
  template: GenerationTemplate;
  set: TemplateStyleSet;
  state: StyleWordsState;
  onPick: (template: GenerationTemplate, style?: string) => void;
}

/**
 * A styled template's third level (inner#1817): a loading row until the style
 * words arrive, a refresh hint if they fail, then the set's styles, under
 * category headings when it has categories and as a two-column thumbnail
 * grid when it has thumbnails.
 * @param root0 - Component props.
 * @param root0.template - The styled template.
 * @param root0.set - Its style set.
 * @param root0.state - Where the style words stand.
 * @param root0.onPick - Applies the template with the picked style.
 * @returns The level's rows.
 */
const TemplateStyleChoices = React.memo(function TemplateStyleChoices({
  template,
  set,
  state,
  onPick,
}: TemplateStyleChoicesProps): React.JSX.Element {
  const t = useTranslation();
  if (state === 'loading') {
    return <p data-testid='generate-template-styles-loading' className='px-2 py-1.5 text-sm text-muted-foreground'>{t('common.loading')}</p>;
  }
  if (state === 'failed') {
    return <p data-testid='generate-template-styles-failed' className='px-2 py-1.5 text-sm text-muted-foreground'>{t('canvas.template.styleLoadFailed')}</p>;
  }
  const groups = set.categories === undefined
    ? [{ category: undefined, styles: set.styles }]
    : set.categories.map((category) => ({ category, styles: set.styles.filter((style) => style.category === category) }));
  return (
    <>
      {groups.map(({ category, styles }, index) => (
        <React.Fragment key={category ?? ''}>
          {index > 0 && <DropdownMenuSeparator />}
          <div>
            {category !== undefined && (
              <DropdownMenuLabel
                data-testid={`generate-template-style-category-${category}`}
                className={cn('sticky top-0 z-10 bg-popover', set.thumbnails && 'px-1.5')}
              >
                {t(`canvas.template.styleSet.${set.id}.category.${category}`)}
              </DropdownMenuLabel>
            )}
            <div className={set.thumbnails ? 'grid grid-cols-2 gap-1' : undefined}>
              {styles.map((style) => (
                <DropdownMenuItem
                  key={style.id}
                  data-testid={`generate-template-style-${style.id}`}
                  onSelect={() => onPick(template, style.id)}
                  className={set.thumbnails ? 'flex-col items-start gap-1 p-1.5' : undefined}
                >
                  {set.thumbnails && (
                    <img
                      src={`/template-styles/${set.id}/${style.id}.webp`}
                      alt=''
                      loading='lazy'
                      className='aspect-[4/3] w-full rounded-content-xs bg-muted object-cover'
                    />
                  )}
                  <span className={set.thumbnails ? 'text-xs' : undefined}>
                    {keepHyphenatedWordsWhole(t(templateStyleKey(set.id, style.id, 'name')))}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          </div>
        </React.Fragment>
      ))}
    </>
  );
});

/**
 * A template line with each hyphenated word kept whole: a browser may wrap
 * after any hyphen, which leaves half a word on the next line.
 * @param line - The line.
 * @returns Its parts, each hyphenated word in a span that does not wrap.
 */
function keepHyphenatedWordsWhole(line: string): React.ReactNode[] {
  return line
    .split(/(\S+-\S+)/)
    .map((part, index) => (index % 2 === 1 ? <span key={index} className='whitespace-nowrap'>{part}</span> : part));
}

/**
 * The template button in a generate panel's corner, left of the close button,
 * and the list it opens (inner#977): the creative goals of the node type's
 * templates, each opening a submenu of its templates (inner#1807). A template
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
  const goals = templateGoalsFor(nodeType);
  const served = React.useMemo(() => new Set(models.map((m) => m.name)), [models]);
  const styled = goals.some(({ templates }) => templates.some((template) => templateStylesOf(template) !== undefined));
  // The style words of the menu's locale download the first time it opens (inner#1817).
  const locale = getLocale();
  const [styleWords, setStyleWords] = React.useState<Readonly<Record<string, boolean>>>({});
  React.useEffect(() => {
    if (!open || !styled) return undefined;
    let live = true;
    void ensureTemplateStyleMessages(locale).then((ok) => {
      if (live) setStyleWords((prev) => ({ ...prev, [locale]: ok }));
    });
    return () => {
      live = false;
    };
  }, [open, styled, locale]);
  const known = styleWords[locale];
  const styleState: StyleWordsState = known === undefined ? 'loading' : known ? 'ready' : 'failed';
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
              className='flex h-6 w-6 items-center justify-center rounded-overlay text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-accent-foreground'
            >
              <LayoutTemplate className='h-3.5 w-3.5' aria-hidden='true' />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side='top'>{t('canvas.template.title')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align='end' avoidCollisions={false} className='w-max max-w-72'>
        <DropdownMenuLabel>{t('canvas.template.title')}</DropdownMenuLabel>
        {goals.length === 0 ? (
          <p data-testid='generate-template-empty' className='px-2 py-1.5 text-sm text-muted-foreground'>
            {t('canvas.template.empty')}
          </p>
        ) : (
          goals.map(({ goal, templates }) => (
            <DropdownMenuSub key={goal}>
              <DropdownMenuSubTrigger data-testid={`generate-template-goal-${goal}`} className='gap-2'>
                <span className='min-w-0 flex-1 truncate'>{t(`canvas.template.goal.${goal}`)}</span>
                <DropdownMenuTrailing>{templates.length}</DropdownMenuTrailing>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className='w-72'>
                {templates.map((template) => {
                  const available = templateServed(template, served);
                  const set = templateStylesOf(template);
                  const label = (
                    <>
                      <span className='flex w-full items-center justify-between gap-2'>
                        <span>{t(`canvas.template.${template.id}.name`)}</span>
                        {!available && (
                          <DropdownMenuTrailing>{t('canvas.template.unavailable')}</DropdownMenuTrailing>
                        )}
                      </span>
                      <span className='text-pretty text-xs text-muted-foreground in-data-[highlighted]:text-foreground'>
                        {keepHyphenatedWordsWhole(t(`canvas.template.${template.id}.description`))}
                      </span>
                    </>
                  );
                  if (set !== undefined && available) {
                    return (
                      <DropdownMenuSub key={template.id}>
                        <DropdownMenuSubTrigger
                          data-testid={`generate-template-${template.id}`}
                          className='items-start gap-2 [&>svg]:mt-0.5'
                        >
                          <span className='flex min-w-0 flex-1 flex-col items-start gap-0.5'>{label}</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className={set.thumbnails ? 'w-80' : undefined}>
                          <TemplateStyleChoices template={template} set={set} state={styleState} onPick={onPick} />
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    );
                  }
                  return (
                    <DropdownMenuItem
                      key={template.id}
                      data-testid={`generate-template-${template.id}`}
                      disabled={!available}
                      onSelect={() => onPick(template)}
                      className='flex-col items-start gap-0.5'
                    >
                      {label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
