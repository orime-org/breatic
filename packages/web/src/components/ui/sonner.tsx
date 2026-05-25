import * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/**
 * shadcn/ui Toaster — toast notification surface backed by sonner.
 *
 * Theme integration: the upstream shadcn template uses `next-themes`. This
 * project uses a custom `data-theme` attribute on `<html>`, so the wrapper
 * reads it directly (with a MutationObserver) instead of pulling in
 * `next-themes`. Result: same look-and-feel, no extra dep.
 *
 * Mount once at the app root:
 *   <App>...</App>
 *   <Toaster richColors closeButton position="bottom-right" />
 *
 * Then `import { toast } from 'sonner'` and call `toast(...)` anywhere.
 */
function useDataTheme(): 'light' | 'dark' {
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined') return 'light';
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  });

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const update = () => {
      setTheme(
        document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useDataTheme();

  return (
    <Sonner
      theme={theme}
      className='toaster group'
      // Sonner ships a runtime-injected CSS rule
      //   `[data-sonner-toaster] { width: var(--width); }`
      //   `[data-sonner-toast][data-styled=true] { width: var(--width); }`
      // BOTH the ol AND the li (toast) read the same `--width` var
      // (default 356px). A Tailwind `w-fit` on the toast className
      // therefore loses to the vendor CSS — the toast stays 356px.
      //
      // Setting `--width: fit-content` (earlier attempt) caused the
      // toast to collapse into a vertical column of single CJK
      // characters: with the toast container `display: flex; gap: 6px`
      // and CJK characters being default-breakable, `fit-content`
      // inside the nested flex layout shrank to `min-content`
      // (= one CJK character wide).
      //
      // `max-content` does NOT take available size into account — it
      // sizes to the content's natural one-line width, regardless of
      // the parent. Short toasts get a tight one-line box; long toasts
      // are capped at 28rem by `max-w-md` on the toast className.
      style={{ '--width': 'max-content' } as React.CSSProperties}
      toastOptions={{
        classNames: {
          // bg-popover matches the rest of the chrome overlay surfaces
          // (Popover / Sheet / Tooltip all read --color-popover); the
          // prior `bg-background` was the page bg token, leaving the
          // toast visually disconnected from the floating overlay
          // language (2026-05-25 user ask).
          // min-h-0 + py-2 px-3 shrinks the toast height from sonner's
          // default ~56px to ~36px — top-center toasts should be
          // compact info bars, not large modal-like cards. Tailwind
          // class on the toast element has same specificity as the
          // vendor `[data-sonner-toast][data-styled=true]` selector
          // but loads after, so cascade wins without !important.
          toast:
            'group toast max-w-md min-h-0 py-2 px-3 group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
