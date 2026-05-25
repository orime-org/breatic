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
      toastOptions={{
        // `w-fit max-w-md` shrinks the toast so it hugs the message
        // text (sonner's default `--width: 356px` left a wide empty
        // bar for short messages like "已锁定"). max-w-md (28rem)
        // caps long messages so they don't span the whole viewport
        // at top-center. PR #140 — user-driven sizing fix.
        classNames: {
          toast:
            'group toast w-fit max-w-md group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
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
