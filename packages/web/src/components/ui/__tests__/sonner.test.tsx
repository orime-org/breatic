import { describe, it, expect, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { toast } from 'sonner';

import { Toaster } from '@/components/ui/sonner';

// NOTE: sonner does not fully render its <section> inside jsdom (it depends
// on browser-only timing). We assert mount + API surface; full visual
// rendering is exercised by Playwright e2e in `tests/smoke/`.

describe('Toaster (sonner)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('mounts without throwing (light default)', () => {
    expect(() => render(<Toaster />)).not.toThrow();
  });

  it('mounts without throwing when data-theme=dark', () => {
    document.documentElement.dataset.theme = 'dark';
    expect(() => render(<Toaster />)).not.toThrow();
  });

  it('mounts with custom position prop without throwing', () => {
    expect(() => render(<Toaster position='top-right' richColors />)).not.toThrow();
  });

  it('toast() default call does not throw', () => {
    render(<Toaster />);
    expect(() => {
      act(() => {
        toast('Hello');
      });
    }).not.toThrow();
  });

  it('toast.success / toast.error variants callable', () => {
    render(<Toaster />);
    expect(() => {
      act(() => {
        toast.success('Done');
        toast.error('Err');
      });
    }).not.toThrow();
  });
});
