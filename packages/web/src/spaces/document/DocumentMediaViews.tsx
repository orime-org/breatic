// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every media block of one editor, rendered into the container its node view
 * made (inner#1127, `document-media-views.ts`).
 */

import * as React from 'react';
import { createPortal } from 'react-dom';

import { DocumentMediaBlock } from '@web/spaces/document/DocumentMediaBlock';
import { setHoveredMedia, useDocumentBars } from '@web/spaces/document/document-bars';
import {
  mediaViewsOf,
  onMediaViewsChange,
} from '@web/spaces/document/document-media-views';

interface DocumentMediaViewsProps {
  /** The editor whose media blocks these are. */
  editor: object;
}

/**
 * The portals, one per media block.
 * @param props - See {@link DocumentMediaViewsProps}.
 * @param props.editor - The editor.
 * @returns The portals.
 */
export function DocumentMediaViews({ editor }: DocumentMediaViewsProps): React.JSX.Element {
  const subscribe = React.useCallback(
    (listener: () => void) => onMediaViewsChange(editor, listener),
    [editor],
  );
  const views = React.useSyncExternalStore(subscribe, () => mediaViewsOf(editor));
  const { hoveredMedia, linkToolbarUp } = useDocumentBars(editor);
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
            type={entry.type}
            props={entry.props}
            selected={entry.selected}
            hovered={hoveredMedia === host}
            // One bar at a time (`document-bars.ts`): the block under the
            // pointer first, then the link toolbar, then the selected block.
            toolbarShown={
              hoveredMedia === null ? entry.selected && !linkToolbarUp : hoveredMedia === host
            }
            host={host}
            onHover={onHover}
            actions={entry.actions}
          />,
          host,
        ),
      )}
    </>
  );
}
