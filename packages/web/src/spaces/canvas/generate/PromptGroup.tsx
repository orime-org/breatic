// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A panel's prompts with one open at a time (#1201): the open one shows its
 * box, every other one is a row naming it with the first line of its words,
 * and clicking a row opens that one. Which one is open is the caller's state.
 *
 * Every box stays mounted: closing hides it, so its words, chips, caret and
 * undo history are there when it opens again. The Root, Item and Content are
 * drawn the same way for one prompt as for several, so a second prompt
 * arriving or leaving never moves the first box in the tree; a lone prompt
 * only swaps its row for its plain name, as it was before there were rows.
 */

import type * as React from 'react';
import type * as Y from 'yjs';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@web/components/ui/accordion';
import { cn } from '@web/lib/utils';
import { usePromptPreviewLine } from '@web/spaces/canvas/generate/prompt-preview';

/** One prompt in the group. */
export interface PromptGroupItem {
  /** Which prompt this is, as `value` names it. */
  readonly id: string;
  /** The name over the box, or undefined for a lone box that has none. */
  readonly name: string | undefined;
  /** Controls beside the name, which work whether the prompt is open or not. */
  readonly controls?: React.ReactNode;
  /**
   * The prompt's words, whose first line its row shows while it is closed;
   * null for a box with no stored prompt, whose row shows the placeholder.
   */
  readonly fragment: Y.XmlFragment | null;
  /** What the row shows when the prompt has no words. */
  readonly placeholder: string;
  /** The box. */
  readonly editor: React.ReactNode;
  /** What tests reach for the prompt by; its row is `${testId}-toggle`. */
  readonly testId?: string;
}

interface PromptGroupProps {
  /** The prompts, in order. */
  items: readonly PromptGroupItem[];
  /** The open prompt's id. */
  value: string;
  /** The reader opened another prompt. */
  onValueChange: (id: string) => void;
  /** Classes for the list. */
  className?: string;
  /** Classes for each prompt. */
  itemClassName?: string;
  /** Classes for each name. */
  nameClassName?: string;
}

/**
 * The prompts, one open.
 * @param root0 - Component props.
 * @param root0.items - The prompts.
 * @param root0.value - The open prompt.
 * @param root0.onValueChange - Called with a prompt the reader opened.
 * @param root0.className - Classes for the list.
 * @param root0.itemClassName - Classes for each prompt.
 * @param root0.nameClassName - Classes for each name.
 * @returns The group.
 */
export function PromptGroup({
  items,
  value,
  onValueChange,
  className,
  itemClassName,
  nameClassName = 'text-xs font-medium text-foreground',
}: PromptGroupProps): React.JSX.Element {
  const lone = items.length === 1;
  return (
    <Accordion type='single' value={value} onValueChange={onValueChange} className={cn('flex flex-col gap-2', className)}>
      {items.map((item) => {
        const open = item.id === value;
        const name = <span className={cn('shrink-0', nameClassName)}>{item.name}</span>;
        return (
          <AccordionItem
            key={item.id}
            value={item.id}
            data-testid={item.testId}
            className={cn('flex flex-col gap-1.5', itemClassName)}
          >
            {(item.name !== undefined || item.controls !== undefined) && (
              <div className='flex min-w-0 items-center gap-2'>
                {lone ? (
                  name
                ) : (
                  <AccordionTrigger data-testid={item.testId === undefined ? undefined : `${item.testId}-toggle`}>
                    {name}
                    {!open && <PreviewLine fragment={item.fragment} placeholder={item.placeholder} />}
                  </AccordionTrigger>
                )}
                {item.controls}
              </div>
            )}
            <AccordionContent forceMount hidden={!open}>
              {item.editor}
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

/**
 * A closed row's line, following the prompt while the row is closed, or its
 * placeholder when the prompt has no words; an open prompt draws no row line
 * and follows nothing.
 * @param root0 - Component props.
 * @param root0.fragment - The prompt, or null for a box with no stored prompt.
 * @param root0.placeholder - What shows when it has no words.
 * @returns The text.
 */
function PreviewLine({
  fragment,
  placeholder,
}: {
  fragment: Y.XmlFragment | null;
  placeholder: string;
}): React.JSX.Element {
  const line = usePromptPreviewLine(fragment);
  return (
    <span className={cn('min-w-0 truncate text-xs', line === '' ? 'text-muted-foreground' : 'text-foreground')}>
      {line === '' ? placeholder : line}
    </span>
  );
}
