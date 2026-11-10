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
import { GitCompare, MoreHorizontal, Pencil, RotateCw, Trash2, Undo2, X } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { yUndoPluginKey } from 'y-prosemirror';
import type { VersionError, VersionOperationResult, VersionSelection, VersionSnapshot } from '@blocknote/core/extensions';
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
import type { UndoBoundary } from '@web/spaces/document/document-proposal-landing';
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
 * The body's undo manager, read off its plugin state.
 * @param editor - The body.
 * @returns It, or null.
 */
function undoOf(editor: Live): UndoBoundary | null {
  const state = yUndoPluginKey.getState(editor.prosemirrorState) as { undoManager?: UndoBoundary } | undefined;
  return state?.undoManager ?? null;
}

type VersionController = VersioningController;

/**
 * The controller's state, as React reads it.
 * @param controller - The controller.
 * @returns Its state.
 */
function useControllerState(controller: VersionController): VersionController['store']['state'] {
  return React.useSyncExternalStore(controller.store.subscribe, () => controller.store.state);
}

/**
 * The snapshot panel, its preview and their dialogs.
 * @param props - Area props.
 * @param props.editor - The live body.
 * @param props.scope - The document.
 * @param props.versions - The panel's switch.
 * @param props.readOnly - Whether the user is a viewer.
 * @param props.viewport - The body's scroller.
 * @param props.columnStyle - The text column's padding.
 * @returns The preview column and the panel.
 */
export default function DocumentVersionArea({
  editor,
  scope,
  versions,
  readOnly,
  viewport,
  columnStyle,
}: DocumentVersionAreaProps): React.JSX.Element {
  const t = useTranslation();
  const host = React.useRef<HTMLDivElement>(null);
  const outcome = React.useRef<'restored' | 'unchanged'>('restored');
  const [compared, setCompared] = React.useState(0);

  const { preview, controller } = React.useMemo(() => {
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
      onShow: (comparing) => {
        if (comparing) setCompared((n) => n + 1);
      },
    });
    return { preview: built, controller: versioningOf(built) };
    // One preview per opening of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (host.current === null) return undefined;
    // The editor takes over the element it mounts on; this one is its own, as
    // the body's surface is, so the column's element keeps React's classes.
    const surface = document.createElement('div');
    host.current.appendChild(surface);
    preview.mount(surface);
    controller.open();
    void controller.list();
    return () => {
      controller.close();
      preview.unmount();
      surface.remove();
    };
  }, [preview, controller]);

  const state = useControllerState(controller);
  const open = state.mode === 'versions' ? state : null;

  // A comparison scrolls its own viewport to the first change; the library's
  // scroll would move every scrolling ancestor.
  React.useEffect(() => {
    if (compared === 0 || viewport === null) return;
    const mark = preview.prosemirrorView?.dom.querySelector('[data-user-ids]');
    if (!(mark instanceof HTMLElement)) return;
    const top = mark.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.scrollTo({ top: Math.max(0, top - viewport.clientHeight / 3), behavior: 'smooth' });
  }, [compared, preview, viewport]);

  // Refreshes the list after a save from the menu while the panel is open.
  const savedOnOpen = React.useRef(versions.saved);
  React.useEffect(() => {
    if (versions.saved !== savedOnOpen.current) void controller.list();
  }, [versions.saved, controller]);

  const failed = React.useCallback((error: VersionError, otherwise: string): void => {
    if (error.type === 'not-found') {
      toast.warning(t('spaces.document.versions.gone'));
      void controller.list();
      return;
    }
    toast.error(otherwise);
  }, [controller, t]);

  const select = React.useCallback(async (target: VersionSelection, compareTo?: string): Promise<void> => {
    const result = await controller.select(target, compareTo === undefined ? undefined : { compareTo });
    if (result.status === 'error') failed(result.error, t('spaces.document.versions.contentFailed'));
  }, [controller, failed, t]);

  const rows = React.useMemo(() => open?.history.data ?? [], [open]);
  const byId = React.useCallback((id: string) => rows.find((row) => row.id === id), [rows]);

  // Comparing with what is shown: the older of the two is the baseline.
  const compareWithShown = React.useCallback((id: string): void => {
    if (open === null) return;
    const shown = open.displayed;
    if (shown.type === 'current') {
      void select({ type: 'current' }, id);
      return;
    }
    const other = byId(shown.id);
    const row = byId(id);
    if (other === undefined || row === undefined) return;
    const [older, newer] = row.createdAt <= other.createdAt ? [row, other] : [other, row];
    void select({ type: 'snapshot', id: newer.id }, older.id);
  }, [open, byId, select]);

  const [renaming, setRenaming] = React.useState<VersionSnapshot | null>(null);
  const [renamePending, setRenamePending] = React.useState(false);
  const rename = React.useCallback(async (name: string): Promise<void> => {
    if (renaming === null) return;
    setRenamePending(true);
    const result: VersionOperationResult = await controller.rename(renaming.id, name === '' ? undefined : name);
    setRenamePending(false);
    if (result.status === 'done') {
      setRenaming(null);
      toast.success(t('spaces.document.versions.renamed'));
    } else if (result.status === 'error') {
      if (result.error.type === 'not-found') setRenaming(null);
      failed(result.error, t('spaces.document.versions.renameFailed'));
    }
  }, [controller, failed, renaming, t]);

  const [deleting, setDeleting] = React.useState<VersionSnapshot | null>(null);
  const [deletePending, setDeletePending] = React.useState(false);
  const remove = React.useCallback(async (event: React.MouseEvent): Promise<void> => {
    // The dialog stays up until the answer is on screen.
    event.preventDefault();
    if (deleting === null) return;
    setDeletePending(true);
    const result = await controller.remove(deleting.id);
    setDeletePending(false);
    setDeleting(null);
    if (result.status === 'done') toast.success(t('spaces.document.versions.deleted'));
    else if (result.status === 'error') failed(result.error, t('spaces.document.versions.deleteFailed'));
  }, [controller, deleting, failed, t]);

  const [confirmingRestore, setConfirmingRestore] = React.useState(false);
  const { setRestoring, closePanel } = versions;
  const restore = React.useCallback(async (event: React.MouseEvent): Promise<void> => {
    event.preventDefault();
    if (open?.displayed.type !== 'snapshot') return;
    setRestoring(true);
    const result = await controller.restore(open.displayed.id);
    setRestoring(false);
    if (result.status !== 'done') {
      setConfirmingRestore(false);
      toast.error(t('spaces.document.versions.restoreFailed'));
      return;
    }
    setConfirmingRestore(false);
    closePanel();
    // Back in the body once it is on screen again.
    requestAnimationFrame(() => viewOf(editor)?.focus());
    if (outcome.current === 'unchanged') toast.info(t('spaces.document.versions.unchanged'));
    else toast.success(t('spaces.document.versions.restored'));
  }, [closePanel, controller, editor, open, setRestoring, t]);

  const restoring = open?.restoring === true || versions.restoring;
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
  /**
   * Whether a snapshot row is what the preview shows, or part of the comparison.
   * @param id - The row's snapshot.
   * @returns True to mark it.
   */
  const active = (id: string | null): boolean => {
    const target = displayed.type === 'snapshot' ? displayed.id : null;
    return comparing !== undefined ? id === comparing || id === target : id === target;
  };

  return (
    <>
      <div data-testid='doc-version-preview' className='flex min-w-0 flex-1 flex-col pr-[var(--doc-body-gutter)]' style={columnStyle}>
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
            <span className='min-w-0 flex-1 truncate'>{t('spaces.document.versions.viewing', { name: nameOf(displayed) })}</span>
            <Button variant='outline' size='sm' icon={<GitCompare />} disabled={restoring} data-testid='doc-version-compare-current' onClick={() => void select({ type: 'current' }, displayed.id)}>
              {t('spaces.document.versions.compareWithCurrent')}
            </Button>
            {!readOnly && (
              <Button size='sm' icon={<Undo2 />} disabled={restoring} data-testid='doc-version-restore' onClick={() => setConfirmingRestore(true)}>
                {t('spaces.document.versions.restore')}
              </Button>
            )}
            <Button variant='outline' size='sm' disabled={restoring} data-testid='doc-version-exit-preview' onClick={() => void select({ type: 'current' })}>
              {t('spaces.document.versions.exitPreview')}
            </Button>
          </div>
        ) : null}
        <div ref={host} data-testid='doc-version-preview-body' className='doc-body-editor mx-auto w-full max-w-3xl [&_.ProseMirror]:outline-none' />
        <FoldRows preview={preview} />
        <DocumentMediaViews editor={preview} readOnly viewport={viewport} />
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
          <VersionRow
            testId='doc-version-row-current'
            active={displayed.type === 'current'}
            title={t('spaces.document.versions.current')}
            onPress={() => void select({ type: 'current' })}
            disabled={restoring}
          />
          {open === null || (open.history.status === 'pending' && rows.length === 0) ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className='my-1 h-11 rounded-content-xs' />)
          ) : open.history.status === 'error' && rows.length === 0 ? (
            <div data-testid='doc-version-load-failed' className='flex items-center justify-between gap-2 px-2.5 py-3 text-sm'>
              <span className='text-muted-foreground'>{t('spaces.document.versions.loadFailed')}</span>
              <Button variant='outline' size='sm' icon={<RotateCw />} onClick={() => void controller.list()}>
                {t('spaces.document.versions.retry')}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div data-testid='doc-version-empty' className='flex flex-col items-center gap-3 px-4 py-8 text-center text-sm text-muted-foreground'>
              {t('spaces.document.versions.empty')}
              {!readOnly && (
                <Button variant='outline' size='sm' onClick={versions.requestSave}>
                  {t('spaces.document.docMenu.saveSnapshot')}
                </Button>
              )}
            </div>
          ) : (
            <>
              {rows.map((row) => (
                <VersionRow
                  key={row.id}
                  testId={`doc-version-row-${row.id}`}
                  active={active(row.id)}
                  title={labelOf(row)}
                  sub={[(row.metadata as SnapshotMetadata | undefined)?.savedBy, savedAt(row.createdAt)].filter(Boolean).join(' · ')}
                  onPress={() => void select({ type: 'snapshot', id: row.id })}
                  disabled={restoring}
                  menu={
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant='chrome-ghost' size='icon' className='size-5.5' aria-label={t('spaces.document.versions.more')} data-testid={`doc-version-row-menu-${row.id}`} disabled={restoring}>
                          <MoreHorizontal className='h-3.5 w-3.5' />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        {!(displayed.type === 'snapshot' && displayed.id === row.id) && (
                          <DropdownMenuItem data-testid='doc-version-compare-shown' onSelect={() => compareWithShown(row.id)}>
                            <GitCompare className='h-4 w-4' />
                            {t('spaces.document.versions.compareWithShown')}
                          </DropdownMenuItem>
                        )}
                        {!readOnly && (
                          <>
                            <DropdownMenuItem data-testid='doc-version-rename' onSelect={() => setRenaming(row)}>
                              <Pencil className='h-4 w-4' />
                              {t('spaces.document.versions.rename')}
                            </DropdownMenuItem>
                            <DropdownMenuItem data-testid='doc-version-delete' className='text-status-error' onSelect={() => setDeleting(row)}>
                              <Trash2 className='h-4 w-4' />
                              {t('spaces.document.versions.delete')}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                />
              ))}
              {open.nextCursor !== undefined && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='mt-1 text-muted-foreground'
                  data-testid='doc-version-load-more'
                  loading={open.history.status === 'pending' && open.history.operation === 'loadMore'}
                  onClick={() => void controller.loadMore()}
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
        pending={renamePending}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => void rename(name)}
      />
      <AlertDialog open={deleting !== null} onOpenChange={(next) => { if (!next && !deletePending) setDeleting(null); }}>
        <AlertDialogContent data-testid='doc-version-delete-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('spaces.document.versions.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('spaces.document.versions.deleteBody', { name: deleting === null ? '' : labelOf(deleting) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant='destructive' loading={deletePending} data-testid='doc-version-delete-confirm' onClick={(event) => void remove(event)}>
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

interface VersionRowProps {
  testId: string;
  active: boolean;
  title: string;
  sub?: string;
  onPress: () => void;
  disabled: boolean;
  menu?: React.ReactNode;
}

/**
 * One row of the panel: the current content or a snapshot.
 * @param props - Row props.
 * @param props.testId - Its test id.
 * @param props.active - Whether it is what the preview shows.
 * @param props.title - Its name.
 * @param props.sub - Who saved it and when.
 * @param props.onPress - Shows it.
 * @param props.disabled - Whether pressing is off.
 * @param props.menu - Its `⋯` menu.
 * @returns The row.
 */
const VersionRow = React.memo(function VersionRow({ testId, active, title, sub, onPress, disabled, menu }: VersionRowProps): React.JSX.Element {
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
        {sub ? <span className='w-full truncate text-xs text-muted-foreground'>{sub}</span> : null}
      </Button>
      {menu ? (
        <div className='absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 has-[[data-state=open]]:opacity-100'>{menu}</div>
      ) : null}
    </div>
  );
});

/**
 * The buttons of a comparison's folded stretches, drawn into the hosts the
 * fold plugin leaves in the preview.
 * @param props - Fold props.
 * @param props.preview - The preview editor.
 * @returns The portals.
 */
function FoldRows({ preview }: { preview: Preview }): React.JSX.Element {
  const t = useTranslation();
  const folds = React.useSyncExternalStore(
    React.useCallback((notify: () => void) => preview.onChange(notify), [preview]),
    () => versionFolds(preview.prosemirrorState),
  );
  return (
    <>
      {folds.map((fold: VersionFold) => {
        const target = preview.prosemirrorView?.dom.querySelector(`[data-version-fold="${CSS.escape(fold.key)}"]`);
        if (!(target instanceof HTMLElement)) return null;
        return createPortal(
          <Button
            variant={null}
            size={null}
            data-testid='doc-version-fold'
            className='my-2 flex w-full items-center justify-center gap-1.5 rounded-content-xs border border-dashed border-border py-1.5 text-xs text-muted-foreground hover-enabled:bg-accent'
            onClick={() => {
              const view = preview.prosemirrorView;
              if (view) view.dispatch(openVersionFold(view.state, fold.key));
            }}
          >
            {t('spaces.document.versions.folded', { count: fold.count })}
          </Button>,
          target,
          fold.key,
        );
      })}
    </>
  );
}
