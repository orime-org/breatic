import * as React from 'react';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronRight } from 'lucide-react';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Accordion — stacked items that open and close, backed by
 * @radix-ui/react-accordion.
 *
 * Changed from the shadcn original to match the approved design: the chevron
 * points right before the trigger's words and turns down while open, the
 * trigger draws no underline and no padding of its own, and content has no
 * open/close animation. `forceMount` on `AccordionContent` keeps a closed
 * item's content mounted and visible: Radix leaves showing and hiding it to
 * the caller, who passes `hidden` while the item is closed.
 */
const Accordion = AccordionPrimitive.Root;

const AccordionItem = AccordionPrimitive.Item;

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className='flex min-w-0 flex-1'>
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-1.5 rounded-chrome text-left outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed [&[data-state=open]>svg]:rotate-90',
        className,
      )}
      {...props}
    >
      <ChevronRight className='h-3.5 w-3.5 shrink-0 text-muted-foreground' aria-hidden='true' />
      {children}
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = AccordionPrimitive.Content;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
