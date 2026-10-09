// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each upload in flight shows in the body (inner#1127 A4, A6).
 *
 * The placeholders' containers are widget decorations the uploads plugin
 * draws at each file's gap (`document-upload-slots.ts`), keyed by slot so they
 * survive every redraw. This renders into them, so the placeholder sits in
 * the body where its block will land and is seen by nobody else.
 */

import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import {
  onUploadSlotHoldersChange,
  onUploadSlotsChange,
  uploadSlotHoldersIn,
  uploadBatchesIn,
  waitingSlots,
  type UploadBatch,
  type UploadSlot,
} from '@web/spaces/document/document-upload-slots';
import type { DocumentUploader } from '@web/spaces/document/document-uploads';
import { viewOf } from '@web/spaces/document/document-editor-view';
import type { SnapshotEditor } from '@web/spaces/document/use-editor-snapshot';

/** No uploads in flight, before the editor has a view. */
const NO_UPLOADS: readonly UploadBatch[] = [];

const NO_HOLDERS: ReadonlyMap<string, HTMLElement> = new Map();

interface DocumentUploadPlaceholdersProps {
  /** The body's editor. */
  editor: SnapshotEditor;
  /** What retries and removes a failed file. */
  uploader: DocumentUploader;
  /** Whether the body is read-only, which takes the retry away. */
  readOnly: boolean;
}

interface PlaceholderProps {
  slot: UploadSlot;
  onRetry: (slotId: string) => void;
  onRemove: (slotId: string) => void;
  canRetry: boolean;
}

/**
 * One placeholder.
 * @param props - See {@link PlaceholderProps}.
 * @param props.slot - The file.
 * @param props.onRetry - Sends it again.
 * @param props.onRemove - Takes the placeholder away.
 * @param props.canRetry - Whether the body may be written to.
 * @returns The placeholder.
 */
const Placeholder = React.memo(function Placeholder({
  slot,
  onRetry,
  onRemove,
  canRetry,
}: PlaceholderProps): React.JSX.Element {
  const t = useTranslation();
  if (slot.phase === 'failed' && slot.failure !== null) {
    const said = t(slot.failure.messageKey, slot.failure.params);
    // A sentence that already names the file is not prefixed with it again.
    const line = said.includes(slot.name) ? said : `${slot.name} · ${said}`;
    return (
      <div
        data-testid='doc-upload-placeholder'
        data-phase='failed'
        className='my-2 flex items-center gap-3 rounded-md border border-dashed border-status-error-border px-3.5 py-3 text-sm text-status-error-foreground'
      >
        <span className='min-w-0 flex-1 truncate'>{line}</span>
        {slot.failure.retryable && canRetry && (
          <Button
            variant='outline'
            size='compact'
            data-testid='doc-upload-retry'
            onClick={() => {
              onRetry(slot.id);
            }}
          >
            {t('spaces.document.media.retry')}
          </Button>
        )}
        <Button
          variant='outline'
          size='compact'
          data-testid='doc-upload-remove'
          onClick={() => {
            onRemove(slot.id);
          }}
        >
          {t('spaces.document.media.remove')}
        </Button>
      </div>
    );
  }
  // A share is shown only while parts remain: a one-part file reports nothing
  // until its only part lands, and after the last part the finish is left.
  const percent =
    slot.progress === null || slot.progress >= 1 ? null : Math.round(slot.progress * 100);
  return (
    <div
      data-testid='doc-upload-placeholder'
      data-phase='uploading'
      className='my-2 flex items-center gap-3 rounded-md border border-dashed border-border px-3.5 py-3 text-sm text-muted-foreground'
    >
      <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' aria-hidden />
      <span className='min-w-0 flex-1 truncate text-foreground'>{slot.name}</span>
      <span className='shrink-0 tabular-nums'>
        {percent === null
          ? t('spaces.document.media.uploading')
          : t('spaces.document.media.uploadingPercent', { percent })}
      </span>
      {percent !== null && (
        <span className='h-1 w-24 shrink-0 overflow-hidden rounded-full bg-muted'>
          <span className='block h-full bg-foreground/60' style={{ width: `${percent}%` }} />
        </span>
      )}
    </div>
  );
});

/**
 * Every placeholder, each in its own container.
 * @param props - See {@link DocumentUploadPlaceholdersProps}.
 * @param props.editor - The body's editor.
 * @param props.uploader - What retries and removes a failed file.
 * @param props.readOnly - Whether the body is read-only.
 * @returns The portals.
 */
export function DocumentUploadPlaceholders({
  editor,
  uploader,
  readOnly,
}: DocumentUploadPlaceholdersProps): React.JSX.Element {
  const batches = React.useSyncExternalStore(onUploadSlotsChange, () => {
    const view = viewOf(editor);
    return view === null ? NO_UPLOADS : uploadBatchesIn(view.state);
  });
  const slots = React.useMemo(() => waitingSlots(batches), [batches]);
  const onRetry = React.useCallback(
    (slotId: string): void => {
      const view = viewOf(editor);
      if (view !== null) uploader.retry(view, slotId);
    },
    [editor, uploader],
  );
  const onRemove = React.useCallback(
    (slotId: string): void => {
      const view = viewOf(editor);
      if (view !== null) uploader.remove(view, slotId);
    },
    [editor, uploader],
  );
  const view = viewOf(editor);
  const subscribeHolders = React.useCallback(
    (listener: () => void) => (view === null ? () => undefined : onUploadSlotHoldersChange(view, listener)),
    [view],
  );
  const holders = React.useSyncExternalStore(subscribeHolders, () =>
    view === null ? NO_HOLDERS : uploadSlotHoldersIn(view),
  );
  return (
    <>
      {slots.map((slot) => {
        const holder = holders.get(slot.id);
        return holder === undefined
          ? null
          : createPortal(
            <Placeholder
              slot={slot}
              onRetry={onRetry}
              onRemove={onRemove}
              canRetry={!readOnly}
            />,
            holder,
            slot.id,
          );
      })}
    </>
  );
}
