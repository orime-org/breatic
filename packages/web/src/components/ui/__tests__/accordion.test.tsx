import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@web/components/ui/accordion';

/**
 * Two items, one open, both contents kept mounted.
 * @param props - Classes to pass through.
 * @param props.className - Applied to the first item, trigger and content.
 * @returns The accordion.
 */
function Two({ className }: { className?: string }): React.JSX.Element {
  return (
    <Accordion type='single' defaultValue='a'>
      <AccordionItem value='a' data-testid='item-a' className={className}>
        <AccordionTrigger className={className}>First</AccordionTrigger>
        <AccordionContent forceMount data-testid='content-a' className={className}>
          Body a
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value='b'>
        <AccordionTrigger>Second</AccordionTrigger>
        <AccordionContent forceMount data-testid='content-b'>
          Body b
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

describe('Accordion', () => {
  it('renders each trigger as a button saying whether its item is open', () => {
    render(<Two />);
    expect(screen.getByRole('button', { name: 'First' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Second' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a closed item\'s content mounted when forced, marked closed', () => {
    render(<Two />);
    expect(screen.getByTestId('content-a')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('content-b')).toBeInTheDocument();
    expect(screen.getByTestId('content-b')).toHaveAttribute('data-state', 'closed');
  });

  it('opens one item and closes the other in single mode', () => {
    render(<Two />);
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    expect(screen.getByTestId('content-b')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('content-a')).toHaveAttribute('data-state', 'closed');
  });

  it('draws the chevron before the name, turned while open', () => {
    render(<Two />);
    const trigger = screen.getByRole('button', { name: 'First' });
    expect(trigger.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(trigger.className).toContain('[&[data-state=open]>svg]:rotate-90');
  });

  it('tints the trigger under the pointer without moving its words', () => {
    render(<Two />);
    const trigger = screen.getByRole('button', { name: 'First' });
    expect(trigger.className).toContain('hover-enabled:bg-accent');
    expect(trigger.className).toContain('px-1');
    expect(trigger.className).toContain('-mx-1');
  });

  it('shows a visible focus ring only on keyboard focus', () => {
    render(<Two />);
    expect(screen.getByRole('button', { name: 'First' }).className).toContain('focus-visible:ring-1');
  });

  it('lets className override defaults through cn()', () => {
    render(<Two className='gap-4' />);
    expect(screen.getByRole('button', { name: 'First' }).className).toContain('gap-4');
    expect(screen.getByRole('button', { name: 'First' }).className).not.toContain('gap-1.5');
    expect(screen.getByTestId('item-a').className).toContain('gap-4');
    expect(screen.getByTestId('content-a').className).toContain('gap-4');
  });

  it('forwards the trigger ref to the button', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <Accordion type='single' defaultValue='a'>
        <AccordionItem value='a'>
          <AccordionTrigger ref={ref}>First</AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    );
    expect(ref.current).toBe(screen.getByRole('button', { name: 'First' }));
  });
});
