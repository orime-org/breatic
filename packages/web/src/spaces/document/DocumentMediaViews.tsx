// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every media block of one editor, rendered into the container its node view
 * made (inner#1127, `document-media-views.ts`).
 */

import * as React from 'react';
import { createPortal } from 'react-dom';

import { captionDraftsFor } from '@web/spaces/document/document-caption-drafts';
import { useTranslation } from '@web/i18n/use-translation';
import { DocumentMediaBlock } from '@web/spaces/document/DocumentMediaBlock';
import { mediaBarShown, mediaEvent, setHoveredMedia, useDocumentBars } from '@web/spaces/document/document-bars';
import {
  mediaViewKey,
  mediaViewsOf,
  onMediaViewsChange,
} from '@web/spaces/document/document-media-views';

interface DocumentMediaViewsProps {
  /** The editor whose media blocks these are. */
  editor: object & { readonly focus: () => void };
  /** Current project edit permission. */
  readOnly?: boolean;
  /** The document's vertical viewport, owned by its ScrollArea. */
  viewport?: HTMLElement | null;
}

/**
 * The portals, one per media block.
 * @param props - See {@link DocumentMediaViewsProps}.
 * @param props.editor - The editor.
 * @param props.readOnly - Current project edit permission.
 * @param props.viewport - The document's own scroll boundary.
 * @returns The portals.
 */
export function DocumentMediaViews({ editor, readOnly = false, viewport = null }: DocumentMediaViewsProps): React.JSX.Element {
  const subscribe = React.useCallback(
    (listener: () => void) => onMediaViewsChange(editor, listener),
    [editor],
  );
  const views = React.useSyncExternalStore(subscribe, () => mediaViewsOf(editor));
  const bars = useDocumentBars(editor);
  const t = useTranslation();
  const drafts = captionDraftsFor(editor);
  const subscribeDrafts = React.useCallback((listener: () => void): (() => void) => drafts.subscribe(listener), [drafts]);
  const saved = React.useSyncExternalStore(subscribeDrafts, () => drafts.all());
  React.useLayoutEffect(() => {
    const present = new Set(views.map(([, entry]) => entry.blockId));
    for (const [, entry] of views) drafts.event(entry.blockId, { type: 'sync', caption: entry.props.caption, readOnly, exists: true });
    for (const draft of drafts.all()) {
      if (draft.exists && !present.has(draft.blockId)) drafts.event(draft.blockId, { type: 'sync', caption: draft.shared, readOnly, exists: false });
    }
  }, [views, drafts, readOnly]);
  React.useEffect(() => () => {
    for (const [host] of mediaViewsOf(editor)) mediaEvent(editor, { type: 'release', host });
  }, [editor]);
  const onHover = React.useCallback(
    (host: HTMLElement, on: boolean): void => {
      setHoveredMedia(editor, host, on);
    },
    [editor],
  );
  return (
    <>
      {views.map(([host, entry]) =>
        createPortal(
          <DocumentMediaBlock
            editor={editor}
            blockId={entry.blockId}
            readOnly={readOnly}
            viewport={viewport}
            type={entry.type}
            props={entry.props}
            selected={entry.selected}
            hovered={bars.hoveredMedia === host}
            toolbarShown={mediaBarShown(bars, host, entry.selected)}
            host={host}
            onHover={onHover}
            actions={entry.actions}
          />,
          host,
          mediaViewKey(host),
        ),
      )}
      {saved.filter((draft) => draft.phase === 'retained').map((draft) => (
        <div key={draft.blockId} data-testid='doc-media-caption-retained' className='m-2 rounded-content-sm border border-border p-2 text-sm'>
          <p className='text-muted-foreground'>{t('spaces.document.media.captionRetained')}</p>
          <input autoComplete='off' readOnly value={draft.value} className='w-full bg-transparent text-foreground'
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault(); event.stopPropagation(); editor.focus();
              drafts.event(draft.blockId, { type: 'cancel', session: draft.session, caption: draft.shared });
            }}
          />
        </div>
      ))}
    </>
  );
}
