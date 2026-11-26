// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { flushSync } from 'react-dom';
import { ArrowDown, Check, CircleAlert, Minus, X } from 'lucide-react';
import { formatBytes, type DesktopDownload, type DesktopDownloadList } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Progress } from '@web/components/ui/progress';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { useDownloadPanelAnchorLeft } from '@web/features/desktop-downloads/DownloadPanelAnchor';
import { getDesktopBridge } from '@web/lib/desktop-bridge';
import { readUserPreferences, writeUserPreference } from '@web/lib/user-preferences-storage';
import { useCurrentUserStore } from '@web/stores/current-user';
import { cn } from '@web/lib/utils';

/** The panel's width (`w-[320px]`), which keeps it inside the window. */
const PANEL_WIDTH = 320;
/** The gap from the window's edges where the page has no anchor (`--space-6`). */
const EDGE_GAP = 12;

/** A place for the panel: its left edge and its distance from the window's bottom. */
interface PanelPosition {
  left: number;
  bottom: number;
}

/**
 * Hold a position inside the window, so the whole panel stays reachable.
 * @param position - Where the panel would go.
 * @param height - The panel's height now.
 * @returns The position, pulled inside the window.
 */
function insideWindow(position: PanelPosition, height: number): PanelPosition {
  return {
    left: Math.min(Math.max(0, position.left), Math.max(0, window.innerWidth - PANEL_WIDTH)),
    bottom: Math.min(Math.max(0, position.bottom), Math.max(0, window.innerHeight - height)),
  };
}

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
    ) : item.state === 'missing' ? (
      <Minus className='size-3.5 text-muted-foreground' />
    ) : (
      <ArrowDown className='size-3.5 text-muted-foreground' />
    );
  return (
    <li className='border-t border-border px-3 py-2.5'>
      <div className='flex min-w-0 items-center gap-2'>
        <span className='flex w-4 shrink-0 justify-center'>{icon}</span>
        <span className={cn('min-w-0 flex-1 truncate', item.state === 'missing' && 'text-muted-foreground')}>{item.name}</span>
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
        {item.state === 'missing' && <p className='mt-1 text-muted-foreground'>{t('desktopDownloads.missing')}</p>}
      </div>
    </li>
  );
});

/**
 * The desktop client's Downloads panel (inner#2041, design §7.3.1): the list
 * the client keeps for this run, read again after every notice, newest row
 * only until the user expands it. It sits where the page's
 * `DownloadPanelAnchor` is (12px from the window's bottom-left corner on a page
 * without one) until the user drags it by its title bar; the dragged place is
 * kept per account, as the Agent column's width is, and held inside the window.
 * Renders nothing in a browser.
 * @returns The panel, or nothing.
 */
export function DownloadPanel(): React.JSX.Element | null {
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

  const userId = useCurrentUserStore((state) => state.user?.id);
  const anchorLeft = useDownloadPanelAnchorLeft();
  // The list arrives after mount, so the effect's read is the first one shown; it reads again for another account.
  const [dragged, setDragged] = React.useState<PanelPosition | null>(null);
  React.useEffect(() => {
    setDragged(readUserPreferences(userId).downloadPanelPosition);
  }, [userId]);
  // The panel's height as drawn: measured when it appears and on every change of its size (rows, expanding, a
  // language switch that wraps a line), before paint, as Floating UI's autoUpdate watches a floating element.
  const [height, setHeight] = React.useState(0);
  const measure = React.useCallback((element: HTMLElement | null) => {
    if (!element) return;
    setHeight(element.offsetHeight);
    const observer = new ResizeObserver(() => flushSync(() => setHeight(element.offsetHeight)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [, setWindowSize] = React.useState(0);
  React.useEffect(() => {
    /**
     * Draw again, so the position is held inside the new window size.
     * @returns Nothing.
     */
    const onResize = (): void => setWindowSize((count) => count + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const position = insideWindow(dragged ?? { left: anchorLeft ?? EDGE_GAP, bottom: EDGE_GAP }, height);

  // The drag in progress: where the pointer went down, the place it started from, and where it has moved to.
  const drag = React.useRef<{ x: number; y: number; from: PanelPosition; moved: PanelPosition | null } | null>(null);
  const startDrag = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // The title bar's buttons click; only the bar itself drags.
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      event.preventDefault();
      // Held by the bar, the pointer's moves and release reach it outside the window too.
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, from: position, moved: null };
    },
    [position],
  );
  const endDrag = React.useCallback(() => {
    const moved = drag.current?.moved;
    drag.current = null;
    if (moved) writeUserPreference(userId, { downloadPanelPosition: moved });
  }, [userId]);
  const followDrag = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current) return;
      // A release the bar never saw: no button is held any more.
      if (event.buttons === 0) {
        endDrag();
        return;
      }
      current.moved = insideWindow(
        { left: current.from.left + event.clientX - current.x, bottom: current.from.bottom - (event.clientY - current.y) },
        height,
      );
      setDragged(current.moved);
    },
    [endDrag, height],
  );

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
      ref={measure}
      data-testid='desktop-download-panel'
      className='fixed z-40 w-[320px] overflow-hidden rounded-overlay border border-border bg-popover text-sm text-popover-foreground shadow-lg'
      style={{ left: position.left, bottom: position.bottom }}
    >
      <header
        className='flex h-9 cursor-move select-none items-center gap-2 px-3'
        onPointerDown={startDrag}
        onPointerMove={followDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
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
