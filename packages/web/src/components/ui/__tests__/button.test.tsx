import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Button } from '@web/components/ui/button';

describe('Button', () => {
  it('renders a <button> with text content', () => {
    render(<Button>Click me</Button>);
    const el = screen.getByRole('button', { name: 'Click me' });
    expect(el.tagName).toBe('BUTTON');
  });

  it('default variant applies primary tokens', () => {
    render(<Button>Default</Button>);
    expect(
      screen.getByRole('button').className,
    ).toContain('bg-primary');
  });

  it('outline variant applies border + background tokens', () => {
    render(<Button variant='outline'>Outline</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('border');
    expect(cls).toContain('bg-background');
  });

  it('size=icon is a square at the default rung (--btn-default)', () => {
    render(<Button size='icon' aria-label='Pick'>i</Button>);
    const cls = screen.getByRole('button').className;
    // Button ladder: icon collapses to a square at the default rung, driven by
    // the --btn-default token (no raw px — see breatic/no-raw-design-values).
    expect(cls).toContain('h-[var(--btn-default)]');
    expect(cls).toContain('w-[var(--btn-default)]');
  });

  it('size=form uses the shared form-control height (--control-height)', () => {
    render(<Button size='form'>Submit</Button>);
    const cls = screen.getByRole('button').className;
    // Form CTAs share the 36px form-control height with inputs/selects so a
    // submit button lines up flush with the field above it (token, no raw px).
    expect(cls).toContain('h-[var(--control-height)]');
  });

  it('asChild renders the wrapped element instead of a button', () => {
    render(
      <Button asChild>
        <a href='/x'>Link</a>
      </Button>,
    );
    const el = screen.getByRole('link', { name: 'Link' });
    expect(el.tagName).toBe('A');
  });

  it('onClick fires on click', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Button loading', () => {
  it('marks the button busy and aria-disabled without the native disabled attribute', () => {
    render(<Button loading>Save</Button>);
    const el = screen.getByRole('button', { name: 'Save' });
    expect(el).toHaveAttribute('aria-busy', 'true');
    expect(el).toHaveAttribute('aria-disabled', 'true');
    expect(el).not.toHaveAttribute('disabled');
    // The same faded look a disabled button has.
    expect(el).toHaveClass('opacity-50', 'cursor-not-allowed');
  });

  it('puts a spinner before the label when there is no icon', () => {
    render(<Button loading>Save</Button>);
    const el = screen.getByRole('button');
    const spinner = el.firstElementChild;
    expect(spinner?.tagName.toLowerCase()).toBe('svg');
    expect(spinner).toHaveClass('animate-spin', 'mr-2', 'h-3.5', 'w-3.5');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveTextContent('Save');
  });

  it('does not call onClick while loading', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps a loading submit button from submitting its form, by click or by Enter in a field', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input aria-label='Name' />
        <Button type='submit' loading>
          Save
        </Button>
      </form>,
    );
    await user.click(screen.getByRole('button'));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'x{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // jsdom keeps focus on a natively disabled button, so focus itself is
  // measured in a real browser (engineering probe for inner#1374); here the
  // attribute that drops it in Chromium is what is pinned.
  it('stays out of the native disabled state when it starts loading after a keyboard press', async () => {
    const user = userEvent.setup();
    function Harness(): React.JSX.Element {
      const [loading, setLoading] = React.useState(false);
      return (
        <Button loading={loading} onClick={() => setLoading(true)}>
          Save
        </Button>
      );
    }
    render(<Harness />);
    await user.tab();
    await user.keyboard('{Enter}');
    const el = screen.getByRole('button');
    expect(el).toHaveAttribute('aria-busy', 'true');
    expect(el).not.toHaveAttribute('disabled');
    expect(el).toHaveFocus();
  });

  it('lets loading win over disabled, and disabled apply again once loading ends', () => {
    const { rerender } = render(
      <Button loading disabled>
        Save
      </Button>,
    );
    expect(screen.getByRole('button')).not.toHaveAttribute('disabled');
    rerender(
      <Button loading={false} disabled>
        Save
      </Button>,
    );
    expect(screen.getByRole('button')).toHaveAttribute('disabled');
  });

  it('renders the icon before the label while idle', () => {
    render(
      <Button icon={<svg data-testid='send' className='h-4 w-4' />}>Send</Button>,
    );
    const el = screen.getByRole('button');
    expect(el.firstElementChild).toBe(screen.getByTestId('send'));
    expect(el).toHaveTextContent('Send');
  });

  it('replaces the icon with a spinner that takes the icon classes', () => {
    render(
      <Button loading icon={<svg data-testid='send' className='h-4 w-4' />}>
        Send
      </Button>,
    );
    const el = screen.getByRole('button');
    expect(screen.queryByTestId('send')).toBeNull();
    const spinner = el.firstElementChild;
    expect(spinner).toHaveClass('animate-spin', 'h-4', 'w-4');
    expect(spinner).not.toHaveClass('mr-2');
  });

  it('replaces the only icon of an icon-only button', () => {
    render(
      <Button
        loading
        aria-label='Generate'
        icon={<svg data-testid='arrow' className='h-4 w-4' />}
      />,
    );
    const el = screen.getByRole('button', { name: 'Generate' });
    expect(screen.queryByTestId('arrow')).toBeNull();
    expect(el.children).toHaveLength(1);
    expect(el.firstElementChild).toHaveClass('animate-spin', 'h-4', 'w-4');
  });

  it('renders exactly as before when loading is not set', () => {
    render(<Button>Save</Button>);
    const el = screen.getByRole('button');
    expect(el).not.toHaveAttribute('aria-busy');
    expect(el).not.toHaveAttribute('aria-disabled');
    expect(el.children).toHaveLength(0);
  });
});
