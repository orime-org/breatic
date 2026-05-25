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
      // with `--width: 356px` as the default. Toast `<li>` inherits
      // that width (100% of the ol). A Tailwind `w-fit` on the toast
      // className therefore loses to the vendor CSS — the toast stays
      // 356px wide regardless. The only treatment that survives is
      // changing the var: setting `--width: fit-content` makes the ol
      // (and its toast child) shrink to the message text. `max-w-md`
      // on the toast className still caps long messages at 28rem.
      style={{ '--width': 'fit-content' } as React.CSSProperties}
      toastOptions={{
        classNames: {
          toast:
            'group toast max-w-md group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
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
