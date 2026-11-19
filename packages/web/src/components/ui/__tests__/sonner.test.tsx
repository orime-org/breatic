import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

import { Toaster } from '@web/components/ui/sonner';
import { toast as appToast } from '@web/lib/toast';

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

  // inner#1737 test spec LB-08: a toast title breaks Japanese between phrases
  // and keeps more than one word on its last line.
  it('LB-08 gives the toast title phrase breaks and a full last line', async () => {
    render(<Toaster />);
    act(() => {
      appToast.error('リクエストの内容が大きすぎます。');
    });
    const title = await waitFor(() => {
      const found = document.querySelector('[data-title]');
      if (found === null) throw new Error('no toast title yet');
      return found;
    });
    expect(title).toHaveClass('[word-break:auto-phrase]', 'text-pretty');
    expect(title).not.toHaveClass('text-balance');
  });
});
