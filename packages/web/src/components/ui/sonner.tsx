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
      // `--width: max-content` lets each toast shrink-wrap its own text
      // (replacing sonner default 356px). Pairs with the global CSS in
      // `src/index.css` that switches the ol to `display: inline-flex`
      // + the li from `position: absolute` to relative so the ol
      // actually fits its children — without that override the ol
      // collapses to width 0 and top-center centering computes around
      // a zero-width box (toast renders right-of-center, see chrome
      // MCP smoke 2026-05-26).
      //
      // Earlier `fit-content` attempt caused CJK toasts to collapse
      // to one-character columns: with the toast container
      // `display: flex; gap: 6px` and CJK characters being default-
      // breakable, `fit-content` inside the nested flex shrank to
      // `min-content`. `max-content` takes the natural one-line width
      // and is capped at 28rem by the `max-w-md` toast className.
      style={{ '--width': 'max-content' } as React.CSSProperties}
      toastOptions={{
        // Inline style (specificity 1,0,0,0) is the only reliable way
        // to override sonner's vendor CSS for bg / text / border /
        // padding / minHeight — its `[data-sonner-toast][data-styled=true]`
        // selector specificity (0,2,0) beats any Tailwind utility class
        // (0,1,0), and cascade order is irrelevant. Prior PR #142
        // attempt used `bg-popover`/`min-h-0`/`py-2 px-3` classNames
        // and they were silently dropped (2026-05-25 user smoke caught
        // it). See memory `feedback_sonner_inline_style_not_class_for_vendor_override`.
        //
        // Token references:
        //   --color-popover           — same surface bg as Popover/Sheet/Tooltip
        //   --color-popover-foreground — paired text color (auto dark/light)
        //   --color-border             — chrome divider token
        // Padding 8px 12px + minHeight 0 brings toast height from sonner
        // default ~56px down to ~36px — compact info bar feel.
        style: {
          background: 'var(--color-popover)',
          color: 'var(--color-popover-foreground)',
          borderColor: 'var(--color-border)',
          padding: '8px 12px',
          minHeight: 0,
        },
        classNames: {
          // max-w-md (max-width) is NOT shadowed by vendor (sonner sets
          // `width: var(--width)`, not `max-width`), so this class
          // genuinely caps long toasts at 28rem. shadow-lg same — vendor
          // shadow is read from CSS var, not directly set on selector.
          toast: 'group toast max-w-md group-[.toaster]:shadow-lg',
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
