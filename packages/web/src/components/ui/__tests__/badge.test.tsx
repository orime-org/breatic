import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Badge } from '@web/components/ui/badge';

describe('Badge', () => {
  it('renders a <div> with text content', () => {
    render(<Badge data-testid='badge'>New</Badge>);
    const el = screen.getByTestId('badge');
    expect(el.tagName).toBe('DIV');
    expect(el).toHaveTextContent('New');
  });

  it('default variant applies primary tokens', () => {
    render(<Badge data-testid='badge'>Default</Badge>);
    const el = screen.getByTestId('badge');
    expect(el.className).toContain('bg-primary');
    expect(el.className).toContain('text-primary-foreground');
  });

  it('secondary variant applies secondary tokens', () => {
    render(
      <Badge data-testid='badge' variant='secondary'>
        Secondary
      </Badge>,
    );
    const el = screen.getByTestId('badge');
    expect(el.className).toContain('bg-secondary');
    expect(el.className).toContain('text-secondary-foreground');
  });

  it('destructive variant applies the status-error coral tint (red-narrowed)', () => {
    render(
      <Badge data-testid='badge' variant='destructive'>
        Delete
      </Badge>,
    );
    const el = screen.getByTestId('badge');
    expect(el.className).toContain('bg-status-error-bg');
    expect(el.className).toContain('text-status-error-foreground');
    expect(el.className).toContain('border-status-error-border');
    expect(el.className).not.toContain('bg-destructive');
  });

  it('outline variant has no background; merges custom className', () => {
    render(
      <Badge data-testid='badge' variant='outline' className='border-blue-500'>
        Outline
      </Badge>,
    );
    const el = screen.getByTestId('badge');
    expect(el.className).toContain('text-foreground');
    expect(el.className).not.toContain('bg-primary');
    expect(el.className).toContain('border-blue-500');
  });
});
