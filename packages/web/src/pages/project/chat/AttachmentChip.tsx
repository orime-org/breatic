// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { AlertCircle, Loader2, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import type { ChatAttachedChip } from '@breatic/shared';
import { attachmentLabel } from '@web/pages/project/chat/attachment-label';
import { previewOf, type PreviewRow } from '@web/pages/project/chat/attachment-preview';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';
import { HoverPreview } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import type { TrayFailure, TrayStatus } from '@web/stores/chat-attachments';

interface AttachmentChipProps {
  /** Which item this is, handed back to `onRemove`. */
  id: string;
  /** What kind of thing it is. */
  type: ChatAttachedChip['type'];
  /** What the reader sees it called; empty for several canvas nodes. */
  name: string;
  /** What is sent for the item, once it has it: previewed on hover. */
  chip?: ChatAttachedChip;
  /** Where it stands; a sent item is always ready. */
  status?: TrayStatus;
  /** Why it failed, when it has. */
  failure?: TrayFailure;
  /** Takes an item out by id, when it can still be taken out. */
  onRemove?: (id: string) => void;
  /** The remove button is held still. */
  removeDisabled?: boolean;
  testId?: string;
}

/**
 * One attached item, drawn the same above the box and in a sent message.
 * @param root0 - The component props.
 * @param root0.id - Which item this is.
 * @param root0.type - What kind of thing it is.
 * @param root0.name - What the reader sees it called.
 * @param root0.chip - What is sent for the item, once it has it.
 * @param root0.status - Where it stands.
 * @param root0.failure - Why it failed, when it has.
 * @param root0.onRemove - Takes an item out by id, when it can still be taken out.
 * @param root0.removeDisabled - The remove button is held still.
 * @param root0.testId - Its test id.
 * @returns The chip.
 */
function AttachmentChipInner({
  id,
  type,
  name,
  chip,
  status = 'ready',
  failure,
  onRemove,
  removeDisabled = false,
  testId,
}: AttachmentChipProps): React.JSX.Element {
  const t = useTranslation();
  // Only the kind and name open the preview: the remove button is a different
  // control, and it takes the keyboard when a neighbouring card is removed.
  // Wrapped whether or not there is anything to show yet, so the label keeps
  // its element when an upload finishes.
  const label = (
    <AttachmentHover chip={chip} name={name}>
      <span className='inline-flex min-w-0 items-center gap-1'>
        {status === 'uploading' ? (
          <Loader2
            className='h-3 w-3 shrink-0 animate-spin text-muted-foreground'
            aria-label={t('chat.composer.attachmentUploading')}
          />
        ) : status === 'failed' ? (
          // The words stay in the body colour: red on its own tint does not
          // reach 4.5:1 at this size. The border, tint and icon carry the red.
          <AlertCircle className='h-3 w-3 shrink-0 text-status-error-foreground' aria-hidden='true' />
        ) : (
          <AttachmentKindIcon type={type} />
        )}
        <span className='truncate'>{attachmentLabel(t, { name, type, chip })}</span>
        {status === 'failed' && failure ? (
          <span className='shrink-0'>{t('chat.composer.attachmentFailed', { reason: failure })}</span>
        ) : null}
      </span>
    </AttachmentHover>
  );
  return (
    <span
      role='listitem'
      data-attachment-id={id}
      data-status={status}
      data-testid={testId}
      className={`inline-flex h-6 max-w-full items-center gap-1 rounded-chrome border pl-2 text-xs ${
        onRemove ? 'pr-1' : 'pr-2'
      } ${
        status === 'failed'
          ? 'border-status-error-border bg-status-error-bg text-foreground'
          : 'border-border bg-chip text-foreground'
      }`}
    >
      {label}
      {onRemove ? (
        <Button
          type='button'
          variant={null}
          size={null}
          disabled={removeDisabled}
          aria-label={t('chat.composer.removeAttachment', { name })}
          onClick={() => onRemove(id)}
          className='inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-chrome text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50'
        >
          <X className='h-3 w-3' />
        </Button>
      ) : null}
    </span>
  );
}

/**
 * An attachment's kind, as the icon it has wherever it is shown: on its card,
 * in the `@` list, as a block in the words.
 * @param root0 - The component props.
 * @param root0.type - What kind of thing it is.
 * @returns The icon.
 */
export function AttachmentKindIcon({ type }: { type: ChatAttachedChip['type'] }): React.JSX.Element {
  const Icon = getNodeIcon(type === 'canvas' ? 'group' : type);
  return <Icon className='h-3 w-3 shrink-0 text-muted-foreground' aria-hidden='true' />;
}

/**
 * What hovering an attachment shows, wherever it is shown: its card and a
 * block that refers to it open the same preview.
 * @param root0 - The component props.
 * @param root0.chip - What is sent for the item, once it has it.
 * @param root0.name - What the reader sees it called.
 * @param root0.children - What opens the preview.
 * @returns The hover target.
 */
export function AttachmentHover({
  chip,
  name,
  children,
}: {
  chip: ChatAttachedChip | undefined;
  name: string;
  children: React.ReactElement;
}): React.JSX.Element {
  const preview = React.useMemo(() => previewOf(chip), [chip]);
  return (
    <HoverPreview
      kind={preview && preview.kind !== 'nodes' ? preview.kind : 'image'}
      src={preview && 'src' in preview ? preview.src : undefined}
      poster={preview?.kind === 'video' ? preview.poster : undefined}
      text={preview?.kind === 'text' ? preview.text : undefined}
      body={preview?.kind === 'nodes' ? <NodeRows rows={preview.rows} more={preview.more} /> : undefined}
      alt={name}
      side='top'
    >
      {children}
    </HoverPreview>
  );
}

/**
 * The nodes a canvas card carries, one row each: a still or the kind's icon,
 * then the name. Laid out like the generate panel's reference rail.
 * @param root0 - The component props.
 * @param root0.rows - The rows to list.
 * @param root0.more - How many nodes are left unlisted.
 * @returns The list.
 */
function NodeRows({ rows, more }: { rows: PreviewRow[]; more: number }): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex flex-col gap-1'>
      {rows.map((row) => {
        const Icon = getNodeIcon(row.kind);
        return (
          <div key={row.id} data-testid='attachment-preview-row' className='flex items-center gap-1.5'>
            {row.thumbnail ? (
              <img src={row.thumbnail} alt='' className='h-6 w-6 shrink-0 rounded object-cover' />
            ) : (
              <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground'>
                <Icon className='h-3.5 w-3.5' aria-hidden='true' />
              </span>
            )}
            <span className='truncate text-xs text-popover-foreground'>{row.name}</span>
          </div>
        );
      })}
      {more > 0 ? (
        <span data-testid='attachment-preview-more' className='text-xs text-muted-foreground'>
          {t('chat.attachment.more', { count: more })}
        </span>
      ) : null}
    </div>
  );
}

/** Rendered again only when its own props change. */
export const AttachmentChip = React.memo(AttachmentChipInner);
