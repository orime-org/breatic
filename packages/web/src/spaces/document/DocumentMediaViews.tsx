// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every media block of one editor, rendered into the container its node view
 * made (inner#1127, `document-media-views.ts`).
 */

import * as React from 'react';
import { createPortal } from 'react-dom';

import { DocumentMediaBlock } from '@web/spaces/document/DocumentMediaBlock';
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
  return (
    <>
      {views.map(([host, entry]) =>
        createPortal(
          <DocumentMediaBlock
            type={entry.type}
            props={entry.props}
            selected={entry.selected}
            actions={entry.actions}
          />,
          host,
        ),
      )}
    </>
  );
}
