// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { ArrowDown, Check, CircleAlert, X } from 'lucide-react';
import { formatBytes, type DesktopDownload, type DesktopDownloadList } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Progress } from '@web/components/ui/progress';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { getDesktopBridge } from '@web/lib/desktop-bridge';
import { cn } from '@web/lib/utils';

/** Which navigation the panel sits beside. */
export type DownloadPanelPlacement = 'project' | 'studio' | 'page';

/**
 * Which navigation the panel sits beside on a page (design §7.3.1).
 * @param pathname - The page's path.
 * @returns The placement.
 */
export function downloadPanelPlacement(pathname: string): DownloadPanelPlacement {
  if (pathname.startsWith('/project/')) return 'project';
  if (pathname === '/studio' || pathname.startsWith('/studio/')) return 'studio';
  return 'page';
}

/**
 * The panel's left edge by placement: right of the Project page's left menu
 * (`LeftFloatingMenu`, 52px wide at `--space-5`), right of the Studio rail
 * (`w-60`, hidden below `md`), else the window edge.
 */
const LEFT: Record<DownloadPanelPlacement, string> = {
  project: 'left-[calc(var(--space-5)+52px+var(--space-6))]',
  studio: 'left-[var(--space-6)] md:left-[calc(15rem+var(--space-6))]',
  page: 'left-[var(--space-6)]',
};

/**
 * One download's row.
 * @param props - The download and how to reveal it.
 * @param props.item - The download.
 * @param props.revealLabel - The reveal button's words for this platform.
 * @param props.onReveal - Show the file in its folder.
 * @returns The row.
 */
const DownloadRow = React.memo(function DownloadRow({
  item,
  revealLabel,
  onReveal,
}: {
  item: DesktopDownload;
  revealLabel: string;
  onReveal: (id: string) => void;
}): React.JSX.Element {
  const t = useTranslation();
  const icon =
    item.state === 'completed' ? (
      <Check className='size-3.5 text-status-success' />
    ) : item.state === 'failed' ? (
      <CircleAlert className='size-3.5 text-status-error' />
    ) : (
      <ArrowDown className='size-3.5 text-muted-foreground' />
    );
  return (
    <li className='border-t border-border px-3 py-2.5'>
      <div className='flex min-w-0 items-center gap-2'>
        <span className='flex w-4 shrink-0 justify-center'>{icon}</span>
        <span className='min-w-0 flex-1 truncate'>{item.name}</span>
      </div>
      <div className='pl-6 text-xs'>
        {item.state === 'progressing' && (
          <>
            <Progress className='mt-1.5' value={item.total > 0 ? Math.min(100, (item.received / item.total) * 100) : null} />
            <p className='mt-1 tabular-nums text-muted-foreground'>
              {item.total > 0
                ? t('desktopDownloads.progress', { received: formatBytes(item.received), total: formatBytes(item.total) })
                : t('desktopDownloads.receivedOnly', { received: formatBytes(item.received) })}
            </p>
          </>
        )}
        {item.state === 'completed' && (
          <div className='mt-1 flex items-center gap-2'>
            <span className='min-w-0 flex-1 truncate text-muted-foreground'>{t('desktopDownloads.savedIn', { folder: item.folder })}</span>
            <Button size='compact' variant='outline' className='shrink-0' onClick={() => onReveal(item.id)}>
              {revealLabel}
            </Button>
          </div>
        )}
        {item.state === 'failed' && <p className='mt-1 text-status-error'>{t('desktopDownloads.failedRow')}</p>}
      </div>
    </li>
  );
});

/**
 * The desktop client's Downloads panel (inner#2041, design §7.3.1): the list
 * the client keeps for this run, read again after every notice, newest row
 * only until the user expands it. Renders nothing in a browser.
 * @param props - The current path.
 * @param props.pathname - The current path, which decides the panel's left edge.
 * @returns The panel, or nothing.
 */
export function DownloadPanel({ pathname }: { pathname: string }): React.JSX.Element | null {
  const t = useTranslation();
  const bridge = getDesktopBridge();
  const [list, setList] = React.useState<DesktopDownloadList | null>(null);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    if (!bridge) return;
    let live = true;
    /** Read the client's list; replies come back in the order they were asked. */
    const read = (): void => {
      void bridge.listDownloads().then((next) => {
        if (live) setList(next);
      });
    };
    // Subscribe first, so a change between the read and the subscription is not missed.
    const unsubscribe = bridge.onDownloadsChanged(read);
    read();
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  const open = list?.open ?? false;
  React.useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);

  const onReveal = React.useCallback(
    (id: string) => {
      void bridge?.revealDownload(id);
    },
    [bridge],
  );
  const toggle = React.useCallback(() => setExpanded((value) => !value), []);
  const dismiss = React.useCallback(() => {
    void bridge?.dismissDownloads();
  }, [bridge]);

  if (!bridge || !list || !open || list.items.length === 0) return null;

  const { items } = list;
  const running = items.filter((item) => item.state === 'progressing').length;
  const failed = items.filter((item) => item.state === 'failed').length;
  const summary = running
    ? t('desktopDownloads.running', { count: running })
    : failed
      ? t('desktopDownloads.failed', { count: failed })
      : t('desktopDownloads.done');
  const revealLabel = bridge.platform === 'darwin' ? t('desktopDownloads.revealMac') : t('desktopDownloads.revealOther');
  const shown = expanded ? items : items.slice(0, 1);

  return (
    <section
      data-testid='desktop-download-panel'
      className={cn(
        'fixed bottom-[var(--space-6)] z-40 w-[320px] overflow-hidden rounded-overlay border border-border bg-popover text-sm text-popover-foreground shadow-lg',
        LEFT[downloadPanelPlacement(pathname)],
      )}
    >
      <header className='flex h-9 items-center gap-2 px-3'>
        <h2 className='font-semibold'>{t('desktopDownloads.title')}</h2>
        <span className='min-w-0 flex-1 truncate text-xs text-muted-foreground'>{summary}</span>
        {items.length > 1 && (
          <Button size='compact' variant='secondary' onClick={toggle}>
            {expanded ? t('desktopDownloads.showLatest') : t('desktopDownloads.showAll', { count: items.length })}
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size='icon' variant='ghost' className='size-6 shrink-0' aria-label={t('desktopDownloads.close')} onClick={dismiss}>
              <X className='size-3.5' />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('desktopDownloads.close')}</TooltipContent>
        </Tooltip>
      </header>
      <ScrollArea viewportClassName='max-h-[260px]'>
        <ul>
          {shown.map((item) => (
            <DownloadRow key={item.id} item={item} revealLabel={revealLabel} onReveal={onReveal} />
          ))}
        </ul>
      </ScrollArea>
    </section>
  );
}
