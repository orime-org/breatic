// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The snapshot panel and the preview beside it (inner#1129 design §7.2–§7.6),
 * loaded in its own chunk when the panel first opens.
 *
 * It takes the place of the body while open: the body itself stays mounted
 * and collaborating, unseen, and the preview is a second, read-only editor
 * that BlockNote's versioning controller drives. Restoring is the one way
 * back into the body, as one undo step.
 */

import { captureException } from '@sentry/react';
import { ChevronsUpDown, GitCompare, MoreHorizontal, Pencil, RotateCw, Trash2, Undo2, X } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';
import type { VersionOperationResult, VersionSelection, VersionSnapshot } from '@blocknote/core/extensions';
import { getLocale } from '@breatic/shared';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Skeleton } from '@web/components/ui/skeleton';
import type { DocumentScope } from '@web/data/api/documents';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { toast } from '@web/lib/toast';
import { commentsOn } from '@web/spaces/document/document-comment-extension';
import { COMMENT_PANEL_WIDTH } from '@web/spaces/document/document-columns';
import { viewOf } from '@web/spaces/document/document-editor-view';
import { undoOf } from '@web/spaces/document/document-proposal-landing';
import { DocumentMediaViews } from '@web/spaces/document/DocumentMediaViews';
import { DocumentSnapshotNameDialog } from '@web/spaces/document/DocumentSnapshotNameDialog';
import { openVersionFold, versionFolds, type VersionFold } from '@web/spaces/document/document-version-fold';
import { restoreSnapshot } from '@web/spaces/document/document-version-restore';
import { createDocumentVersionStorage, type ShownRef, type SnapshotMetadata } from '@web/spaces/document/document-version-storage';
import { buildVersionPreview, versioningOf, type VersioningController } from '@web/spaces/document/document-version-view';
import type { DocumentVersions } from '@web/spaces/document/use-document-versions';
import type { DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';

type Live = DocumentEditorHandle['editor'];
type Preview = ReturnType<typeof buildVersionPreview>;

const PANEL_WIDTH: React.CSSProperties = { width: COMMENT_PANEL_WIDTH };

interface DocumentVersionAreaProps {
  /** The live body's editor. */
  editor: Live;
  /** Subscribes to that editor being evicted, which happens when its tab closes. */
  onEvict: DocumentEditorHandle['onEvict'];
  /** The document. */
  scope: DocumentScope;
  /** The panel's switch. */
  versions: DocumentVersions;
  /** True for a viewer: nothing that writes is drawn. */
  readOnly: boolean;
  /** The body's scroller, which also scrolls the preview. */
  viewport: HTMLElement | null;
  /** The text column's own padding, so the preview sits where the body does. */
  columnStyle: React.CSSProperties;
}

/**
 * When a snapshot was saved, in the user's language.
 * @param at - Unix milliseconds.
 * @returns The text.
 */
function savedAt(at: number): string {
  return new Date(at).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * What a row is called: its name, else when it was saved.
 * @param snapshot - The row.
 * @returns The label.
 */
function labelOf(snapshot: VersionSnapshot): string {
  return snapshot.name ?? savedAt(snapshot.createdAt);
}

/**
 * Who saved a row and, when its label is a name, when; an unnamed row's label
 * already says when.
 * @param snapshot - The row.
 * @returns Who and when, either of which may be missing.
 */
function detailOf(snapshot: VersionSnapshot): { by?: string; at?: string } {
  return {
    by: (snapshot.metadata as SnapshotMetadata | undefined)?.savedBy ?? undefined,
    at: snapshot.name === undefined ? undefined : savedAt(snapshot.createdAt),
  };
}

/** The panel's operations, each marked waiting while it runs. */
type PanelAction = 'select' | 'rename' | 'delete' | 'restore' | 'page' | 'retry';

/**
 * The controller's state, as React reads it.
 * @param controller - The controller.
 * @returns Its state.
 */
function useControllerState(controller: VersioningController): VersioningController['store']['state'] {
  return React.useSyncExternalStore(controller.store.subscribe, () => controller.store.state);
}

/**
 * The snapshot panel, its preview and their dialogs.
 * @param props - Area props.
 * @param props.editor - The live body.
 * @param props.onEvict - Subscribes to the live body's editor being evicted.
 * @param props.scope - The document.
 * @param props.versions - The panel's switch.
 * @param props.readOnly - Whether the user is a viewer.
 * @param props.viewport - The body's scroller.
 * @param props.columnStyle - The text column's padding.
 * @returns The preview column and the panel.
 */
export default function DocumentVersionArea({
  editor,
  onEvict,
  scope,
  versions,
  readOnly,
  viewport,
  columnStyle,
}: DocumentVersionAreaProps): React.JSX.Element {
  const t = useTranslation();
  const host = React.useRef<HTMLDivElement>(null);
  const outcome = React.useRef<'restored' | 'unchanged'>('restored');
  const [shownNow, setShownNow] = React.useState<{ comparing: boolean } | null>(null);

  // One preview per opening of the panel.
  const [{ preview, controller }] = React.useState(() => {
    const shown: ShownRef = { current: null };
    const storage = createDocumentVersionStorage({
      scope,
      shown,
      apply: (content) => {
        outcome.current = restoreSnapshot({
          editor,
          undoManager: undoOf(editor),
          content,
          threads: commentsOn(editor)?.threadStore.getThreads() ?? null,
        });
      },
      report: (err) => captureException(err, { tags: { area: 'document_version_restore' } }),
    });
    const built = buildVersionPreview({
      live: () => editor.prosemirrorState.doc,
      storage,
      shown,
      onShow: (comparing) => setShownNow({ comparing }),
    });
    return { preview: built, controller: versioningOf(built) };
  });

  const state = useControllerState(controller);
  const open = state.mode === 'versions' ? state : null;

  // A comparison scrolls its own viewport to the first change; the library's
  // scroll would move every scrolling ancestor.
  // Once per display: a Space shown again runs this effect anew.
  const handled = React.useRef<{ comparing: boolean } | null>(null);
  React.useEffect(() => {
    if (shownNow === null || shownNow === handled.current || viewport === null) return;
    handled.current = shownNow;
    if (!shownNow.comparing) return;
    // Looked up in our own element: the preview's view throws once unmounted.
    const mark = host.current?.querySelector('[data-user-ids]');
    if (!(mark instanceof HTMLElement)) return;
    // The library's mark wrappers are `display: contents` and have no box of
    // their own; what they hold does.
    const words = document.createRange();
    words.selectNodeContents(mark);
    const top = words.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.scrollTo({ top: Math.max(0, top - viewport.clientHeight / 3), behavior: 'smooth' });
  }, [shownNow, viewport]);

  // Refreshes the list after a snapshot is saved while the panel is open (its
  // empty state's Save snapshot button).
  const savedOnOpen = React.useRef(versions.saved);
  React.useEffect(() => {
    if (versions.saved !== savedOnOpen.current) void controller.list();
  }, [versions.saved, controller]);

  // Every operation of the panel goes through here: it is marked waiting
  // from the press until its answer, and every way it can end is told to the
  // user the same way. `failure` null leaves a failed page to the list's own
  // error row.
  const [busy, setBusy] = React.useState<ReadonlySet<PanelAction>>(() => new Set());
  const run = React.useCallback(async (
    action: PanelAction,
    operation: () => Promise<VersionOperationResult>,
    failure: string | null,
  ): Promise<'done' | 'gone' | 'failed' | 'dropped'> => {
    setBusy((now) => new Set(now).add(action));
    try {
      const result = await operation();
      if (result.status === 'done') return 'done';
      if (result.status !== 'error') return 'dropped';
      // Only an operation on one snapshot finds it gone; a page is the list's.
      if (result.error.type === 'not-found' && failure !== null) {
        toast.warning(t('spaces.document.versions.gone'));
        void controller.list();
        return 'gone';
      }
      if (failure !== null) toast.error(failure);
      return 'failed';
    } catch (err) {
      captureException(err, { tags: { area: 'document_versions', action } });
      toast.error(failure ?? t('spaces.document.versions.loadFailed'));
      return 'failed';
    } finally {
      setBusy((now) => {
        const next = new Set(now);
        next.delete(action);
        return next;
      });
    }
  }, [controller, t]);

  const select = React.useCallback(async (target: VersionSelection, compareTo?: string): Promise<void> => {
    await run('select', () => controller.select(target, compareTo === undefined ? undefined : { compareTo }), t('spaces.document.versions.contentFailed'));
  }, [controller, run, t]);

  // The preview lives as long as this opening of the panel, and a hidden Space
  // keeps it as it keeps the body (§7.3, inner#1235): what it shows, a
  // selection still loading, its open folds and the list. It is let go when
  // the panel closes, or with the body's editor when the tab is closed while
  // hidden, because a hidden component never runs its cleanup again.
  const letGo = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    const at = host.current;
    if (at === null) return undefined;
    if (letGo.current === null) {
      // The editor takes over the element it mounts on; this one is its own,
      // as the body's surface is, so the column's element keeps React's classes.
      const surface = document.createElement('div');
      at.appendChild(surface);
      preview.mount(surface);
      controller.open();
      void controller.list();
      let unsubscribe: (() => void) | null = null;
      let live = true;
      /** Ends the preview, once. */
      const release = (): void => {
        if (!live) return;
        live = false;
        unsubscribe?.();
        controller.close();
        preview.unmount();
        surface.remove();
      };
      unsubscribe = onEvict(release);
      letGo.current = release;
    }
    return () => {
      // A hidden Space runs this too and keeps its elements in the page.
      if (!at.isConnected) letGo.current?.();
    };
  }, [preview, controller, onEvict]);

  const rows = React.useMemo(() => open?.history.data ?? [], [open]);
  // Every row seen since the panel opened: a refresh goes back to the first
  // page, and what is shown or compared may come from a later one.
  const seen = React.useRef(new Map<string, VersionSnapshot>());
  for (const row of rows) seen.current.set(row.id, row);
  const byId = React.useCallback((id: string) => seen.current.get(id), []);

  // Comparing with what is shown: the older of the two is the baseline.
  const compareWithShown = React.useCallback((id: string): void => {
    const now = controller.store.state;
    if (now.mode !== 'versions') return;
    const shown = now.displayed;
    if (shown.type === 'current') {
      void select({ type: 'current' }, id);
      return;
    }
    const other = byId(shown.id);
    const row = byId(id);
    if (other === undefined || row === undefined) return;
    const [older, newer] = row.createdAt <= other.createdAt ? [row, other] : [other, row];
    void select({ type: 'snapshot', id: newer.id }, older.id);
  }, [controller, byId, select]);

  const [renaming, setRenaming] = React.useState<VersionSnapshot | null>(null);
  const rename = React.useCallback(async (name: string): Promise<void> => {
    if (renaming === null) return;
    const ended = await run('rename', () => controller.rename(renaming.id, name === '' ? undefined : name), t('spaces.document.versions.renameFailed'));
    if (ended === 'done') toast.success(t('spaces.document.versions.renamed'));
    if (ended === 'done' || ended === 'gone') setRenaming(null);
  }, [controller, renaming, run, t]);

  const [deleting, setDeleting] = React.useState<VersionSnapshot | null>(null);
  const remove = React.useCallback(async (event: React.MouseEvent): Promise<void> => {
    // The dialog stays up until the answer is on screen.
    event.preventDefault();
    if (deleting === null) return;
    const ended = await run('delete', () => controller.remove(deleting.id), t('spaces.document.versions.deleteFailed'));
    if (ended === 'done') toast.success(t('spaces.document.versions.deleted'));
    if (ended === 'done' || ended === 'gone') setDeleting(null);
  }, [controller, deleting, run, t]);

  const [confirmingRestore, setConfirmingRestore] = React.useState(false);
  const { setRestoring, closePanel } = versions;
  const restore = React.useCallback(async (event: React.MouseEvent): Promise<void> => {
    event.preventDefault();
    if (open?.displayed.type !== 'snapshot') return;
    const id = open.displayed.id;
    setRestoring(true);
    const ended = await run('restore', () => controller.restore(id), t('spaces.document.versions.restoreFailed'));
    setRestoring(false);
    if (ended !== 'done') return;
    setConfirmingRestore(false);
    closePanel();
    // Back in the body once it is on screen again.
    requestAnimationFrame(() => viewOf(editor)?.focus());
    if (outcome.current === 'unchanged') toast.info(t('spaces.document.versions.unchanged'));
    else toast.success(t('spaces.document.versions.restored'));
  }, [closePanel, controller, editor, open, run, setRestoring, t]);

  const restoring = versions.restoring;
  const displayed = open?.displayed ?? { type: 'current' as const };
  const comparing = open?.compareTo;
  /**
   * What the banner calls a selection or a snapshot id.
   * @param selection - It.
   * @returns Its label.
   */
  const nameOf = (selection: VersionSelection | string): string => {
    const id = typeof selection === 'string' ? selection : selection.type === 'snapshot' ? selection.id : null;
    const row = id === null ? undefined : byId(id);
    return row === undefined ? t('spaces.document.versions.current') : labelOf(row);
  };
  const shownId = displayed.type === 'snapshot' ? displayed.id : null;
  const shownRow = shownId === null ? undefined : byId(shownId);
  const shownDetail = shownRow === undefined ? [] : Object.values(detailOf(shownRow)).filter(Boolean);
  const showCurrent = React.useCallback(() => void select({ type: 'current' }), [select]);
  const showSnapshot = React.useCallback((id: string) => void select({ type: 'snapshot', id }), [select]);
  const failedPage = open?.history.status === 'error' ? open.history.operation : null;
  const retrying = busy.has('retry');
  const retryPage = React.useCallback(() => {
    void run('retry', () => (failedPage === 'loadMore' ? controller.loadMore() : controller.list()), null);
  }, [controller, failedPage, run]);
  const failedRow = (
    <div data-testid='doc-version-load-failed' className='flex items-center justify-between gap-2 px-2.5 py-3 text-sm'>
      <span className='text-muted-foreground'>{t('spaces.document.versions.loadFailed')}</span>
      <Button variant='outline' size='sm' icon={<RotateCw />} loading={retrying} onClick={retryPage}>
        {t('spaces.document.versions.retry')}
      </Button>
    </div>
  );

  return (
    <>
      {/* The banner spans the whole body area; the column beneath it keeps
          the body's gutters. */}
      <div data-testid='doc-version-preview' className='flex min-w-0 flex-1 flex-col'>
        {comparing !== undefined ? (
          <div data-testid='doc-version-banner' className='sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-popover px-4 py-2 text-sm'>
            <span className='min-w-0 flex-1 truncate'>
              {t('spaces.document.versions.comparing', { from: nameOf(comparing), to: nameOf(displayed) })}
            </span>
            <span className='flex shrink-0 items-center gap-2 text-xs'>
              <span className='doc-version-legend-insert rounded-chrome px-1'>{t('spaces.document.versions.legendInsert')}</span>
              <span className='doc-version-legend-delete'>{t('spaces.document.versions.legendDelete')}</span>
              <span className='doc-version-legend-format rounded-chrome px-1'>{t('spaces.document.versions.legendFormat')}</span>
            </span>
            <Button variant='outline' size='sm' disabled={restoring} data-testid='doc-version-exit-compare' onClick={() => void select(displayed)}>
              {t('spaces.document.versions.exitCompare')}
            </Button>
          </div>
        ) : displayed.type === 'snapshot' ? (
          <div data-testid='doc-version-banner' className='sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-popover px-4 py-2 text-sm'>
            <span className='min-w-0 flex-1 truncate'>
              {t('spaces.document.versions.viewing', { name: nameOf(displayed) })}
              {shownDetail.length > 0 && <span className='text-muted-foreground'>{` · ${shownDetail.join(' · ')}`}</span>}
            </span>
            <Button variant='outline' size='sm' icon={<GitCompare />} disabled={restoring} data-testid='doc-version-compare-current' onClick={() => void select({ type: 'current' }, displayed.id)}>
              {t('spaces.document.versions.compareWithCurrent')}
            </Button>
            {!readOnly && (
              <Button size='sm' icon={<Undo2 />} disabled={restoring || open?.pending !== undefined} data-testid='doc-version-restore' onClick={() => setConfirmingRestore(true)}>
                {t('spaces.document.versions.restore')}
              </Button>
            )}
            <Button variant='outline' size='sm' disabled={restoring} data-testid='doc-version-exit-preview' onClick={() => void select({ type: 'current' })}>
              {t('spaces.document.versions.exitPreview')}
            </Button>
          </div>
        ) : null}
        <div className='flex flex-1 flex-col pr-[var(--doc-body-gutter)]' style={columnStyle}>
          <div ref={host} data-testid='doc-version-preview-body' className='doc-body-editor mx-auto w-full max-w-3xl [&_.ProseMirror]:outline-none' />
          <FoldRows preview={preview} host={host} />
          <DocumentMediaViews editor={preview} readOnly viewport={viewport} />
        </div>
      </div>
      <aside data-testid='doc-version-panel' className='flex flex-none flex-col border-l border-border' style={PANEL_WIDTH}>
        <div className='sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background px-3 py-2'>
          <span className='min-w-0 truncate text-sm font-medium'>{t('spaces.document.versions.title')}</span>
          <Button
            variant='chrome-ghost'
            size='icon'
            className='ml-auto size-5.5 shrink-0'
            aria-label={t('spaces.document.versions.close')}
            data-testid='doc-version-close'
            disabled={restoring}
            onClick={closePanel}
          >
            <X className='h-3.5 w-3.5' />
          </Button>
        </div>
        <div className='flex flex-col gap-1 p-2'>
          <RowButton
            testId='doc-version-row-current'
            active={displayed.type === 'current'}
            title={t('spaces.document.versions.current')}
            onPress={showCurrent}
            disabled={restoring}
          />
          {open === null || (open.history.status === 'pending' && rows.length === 0) ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className='my-1 h-11 rounded-content-xs' />)
          ) : (failedPage !== null || retrying) && rows.length === 0 ? (
            failedRow
          ) : rows.length === 0 ? (
            <div data-testid='doc-version-empty' className='flex flex-col items-center gap-3 px-4 py-8 text-center text-sm'>
              <span className='text-muted-foreground'>{t('spaces.document.versions.empty')}</span>
              {!readOnly && (
                <Button variant='outline' size='sm' onClick={versions.requestSave}>
                  {t('spaces.document.docMenu.saveSnapshot')}
                </Button>
              )}
            </div>
          ) : (
            <>
              {rows.map((row) => (
                <SnapshotRow
                  key={row.id}
                  row={row}
                  active={row.id === shownId || row.id === comparing}
                  shown={row.id === shownId}
                  readOnly={readOnly}
                  disabled={restoring}
                  onShow={showSnapshot}
                  onCompare={compareWithShown}
                  onRename={setRenaming}
                  onDelete={setDeleting}
                />
              ))}
              {failedPage !== null || retrying ? failedRow : open.nextCursor !== undefined && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='mt-1 text-muted-foreground'
                  data-testid='doc-version-load-more'
                  loading={busy.has('page')}
                  onClick={() => void run('page', () => controller.loadMore(), null)}
                >
                  {t('spaces.document.versions.loadMore')}
                </Button>
              )}
            </>
          )}
        </div>
      </aside>
      <DocumentSnapshotNameDialog
        mode={renaming === null ? null : 'rename'}
        currentName={renaming?.name ?? ''}
        pending={busy.has('rename')}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => void rename(name)}
      />
      <AlertDialog open={deleting !== null} onOpenChange={(next) => { if (!next && !busy.has('delete')) setDeleting(null); }}>
        <AlertDialogContent data-testid='doc-version-delete-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('spaces.document.versions.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('spaces.document.versions.deleteBody', { name: deleting === null ? '' : labelOf(deleting) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy.has('delete')}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant='destructive' loading={busy.has('delete')} data-testid='doc-version-delete-confirm' onClick={(event) => void remove(event)}>
              {t('spaces.document.versions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmingRestore} onOpenChange={(next) => { if (!next && !restoring) setConfirmingRestore(false); }}>
        <AlertDialogContent data-testid='doc-version-restore-dialog' onCloseAutoFocus={(event) => event.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('spaces.document.versions.restoreTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('spaces.document.versions.restoreBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction loading={restoring} data-testid='doc-version-restore-confirm' onClick={(event) => void restore(event)}>
              {t('spaces.document.versions.restore')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface RowButtonProps {
  testId: string;
  active: boolean;
  title: string;
  by?: string;
  at?: string;
  onPress: () => void;
  disabled: boolean;
  children?: React.ReactNode;
}

/**
 * The pressable part of a row: the current content or a snapshot.
 * @param props - Row props.
 * @param props.testId - Its test id.
 * @param props.active - Whether it is what the preview shows.
 * @param props.title - Its name.
 * @param props.by - Who saved it.
 * @param props.at - When it was saved, when the title does not say so.
 * @param props.onPress - Shows it.
 * @param props.disabled - Whether pressing is off.
 * @param props.children - Its `⋯` menu.
 * @returns The row.
 */
const RowButton = React.memo(function RowButton({ testId, active, title, by, at, onPress, disabled, children }: RowButtonProps): React.JSX.Element {
  return (
    <div className='group relative'>
      <Button
        variant={null}
        size={null}
        data-testid={testId}
        data-active={active ? 'true' : undefined}
        disabled={disabled}
        onClick={onPress}
        className={cn(
          'flex w-full flex-col items-start gap-0.5 rounded-content-xs border px-2.5 py-2 text-left',
          active ? 'border-active-border bg-accent' : 'border-transparent hover-enabled:bg-accent',
        )}
      >
        <span className='w-full truncate pr-6 text-sm'>{title}</span>
        {by || at ? (
          // The name gives way; when stays whole, as on a comment card.
          <span className={cn('flex w-full gap-1 text-xs', active ? 'text-foreground-secondary' : 'text-muted-foreground')}>
            {by ? <span className='min-w-0 truncate'>{by}</span> : null}
            {by && at ? <span className='shrink-0'>·</span> : null}
            {at ? <span className='shrink-0 whitespace-nowrap'>{at}</span> : null}
          </span>
        ) : null}
      </Button>
      {children ? (
        <div className='absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 has-[[data-state=open]]:opacity-100'>{children}</div>
      ) : null}
    </div>
  );
});

interface SnapshotRowProps {
  row: VersionSnapshot;
  /** Shown, or one side of the comparison. */
  active: boolean;
  /** What the preview shows, so comparing with it is not offered. */
  shown: boolean;
  readOnly: boolean;
  disabled: boolean;
  onShow: (id: string) => void;
  onCompare: (id: string) => void;
  onRename: (row: VersionSnapshot) => void;
  onDelete: (row: VersionSnapshot) => void;
}

/**
 * One snapshot's row and its `⋯` menu.
 * @param props - Row props.
 * @param props.row - The snapshot.
 * @param props.active - Whether it is shown or compared.
 * @param props.shown - Whether the preview shows it.
 * @param props.readOnly - Whether the user is a viewer.
 * @param props.disabled - Whether pressing is off.
 * @param props.onShow - Shows a snapshot.
 * @param props.onCompare - Compares a snapshot with what is shown.
 * @param props.onRename - Opens the rename dialog.
 * @param props.onDelete - Opens the delete dialog.
 * @returns The row.
 */
const SnapshotRow = React.memo(function SnapshotRow({ row, active, shown, readOnly, disabled, onShow, onCompare, onRename, onDelete }: SnapshotRowProps): React.JSX.Element {
  const t = useTranslation();
  const press = React.useCallback(() => onShow(row.id), [onShow, row.id]);
  const { by, at } = detailOf(row);
  return (
    <RowButton testId={`doc-version-row-${row.id}`} active={active} title={labelOf(row)} by={by} at={at} onPress={press} disabled={disabled}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant='chrome-ghost' size='icon' className='size-6' aria-label={t('spaces.document.versions.more')} data-testid={`doc-version-row-menu-${row.id}`} disabled={disabled}>
            <MoreHorizontal className='h-3.5 w-3.5' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          {!shown && (
            <DropdownMenuItem data-testid='doc-version-compare-shown' onSelect={() => onCompare(row.id)}>
              <GitCompare className='h-4 w-4' />
              {t('spaces.document.versions.compareWithShown')}
            </DropdownMenuItem>
          )}
          {!readOnly && (
            <>
              <DropdownMenuItem data-testid='doc-version-rename' onSelect={() => onRename(row)}>
                <Pencil className='h-4 w-4' />
                {t('spaces.document.versions.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem data-testid='doc-version-delete' className='text-status-error' onSelect={() => onDelete(row)}>
                <Trash2 className='h-4 w-4' />
                {t('spaces.document.versions.delete')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </RowButton>
  );
});

/**
 * The buttons of a comparison's folded stretches, drawn into the hosts the
 * fold plugin leaves in the preview.
 * @param props - Fold props.
 * @param props.preview - The preview editor.
 * @param props.host - The element the preview is mounted in; the preview's
 * view throws once it is unmounted, while this one is then empty.
 * @returns The portals.
 */
function FoldRows({ preview, host }: { preview: Preview; host: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const t = useTranslation();
  const folds = React.useSyncExternalStore(
    React.useCallback((notify: () => void) => preview.onChange(notify), [preview]),
    () => versionFolds(preview.prosemirrorState),
  );
  return (
    <>
      {folds.map((fold: VersionFold) => {
        const target = host.current?.querySelector(`[data-version-fold="${CSS.escape(fold.key)}"]`);
        if (!(target instanceof HTMLElement)) return null;
        return createPortal(
          <Button
            variant={null}
            size={null}
            data-testid='doc-version-fold'
            className='flex h-full w-full items-center justify-center gap-1.5 rounded-content-xs border border-dashed border-border py-1.5 text-xs text-muted-foreground hover-enabled:bg-accent'
            onClick={() => {
              const view = preview.prosemirrorView;
              if (view) view.dispatch(openVersionFold(view.state, fold.key));
            }}
          >
            <ChevronsUpDown className='h-3.5 w-3.5' />
            {t('spaces.document.versions.folded', { count: fold.count })}
          </Button>,
          target,
          fold.key,
        );
      })}
    </>
  );
}
