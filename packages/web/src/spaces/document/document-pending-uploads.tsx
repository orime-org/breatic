// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a pending media block reads what it shows (inner#1351 + inner#1390
 * design §5.5): this page's upload controller, this page's write access to
 * the body, and the claims other clients put in awareness. A body rendered
 * without a provider knows none of these, and every pending block in it
 * reads as not finished.
 */

import * as React from 'react';

import { DocumentPendingMedia } from '@web/spaces/document/DocumentPendingMedia';
import type { MediaBlockActions, MediaBlockProps } from '@web/spaces/document/DocumentMediaBlock';
import { pendingStatus, type PendingFacts, type PendingStatus } from '@web/spaces/document/document-pending-status';

/** What a body's pending blocks read from. */
export interface PendingUploadsStore {
  /** What this page knows about an upload, read now. */
  factsOf: (uploadId: string) => PendingFacts;
  /**
   * Calls back whenever any of it may have changed.
   * @returns What stops listening.
   */
  subscribe: (listener: () => void) => () => void;
  /** Runs a failed upload again. */
  retry: (uploadId: string) => void;
}

const NOTHING_KNOWN: PendingUploadsStore = {
  factsOf: () => ({ entry: undefined, access: 'unknown', refused: false, claim: null }),
  subscribe: () => () => {},
  retry: () => {},
};

/** The store a body's pending blocks read from. */
export const PendingUploadsContext = React.createContext<PendingUploadsStore>(NOTHING_KNOWN);

/**
 * What a pending block shows, kept current.
 * @param uploadId - The block's upload id.
 * @returns Its status.
 */
function usePendingStatus(uploadId: string): PendingStatus {
  const store = React.useContext(PendingUploadsContext);
  const snapshot = React.useCallback(
    (): string => JSON.stringify(pendingStatus(store.factsOf(uploadId))),
    [store, uploadId],
  );
  const key = React.useSyncExternalStore(store.subscribe, snapshot);
  return React.useMemo(() => JSON.parse(key) as PendingStatus, [key]);
}

/** Props of {@link DocumentPendingMediaBlock}. */
interface DocumentPendingMediaBlockProps {
  readonly props: MediaBlockProps;
  readonly actions: MediaBlockActions;
}

/**
 * A pending media block, as its node view renders it.
 * @param props - See {@link DocumentPendingMediaBlockProps}.
 * @param props.props - The block's props; its `uploadId` is set.
 * @param props.actions - What the block's controls do.
 * @returns The frame.
 */
export const DocumentPendingMediaBlock = React.memo(function DocumentPendingMediaBlock({
  props,
  actions,
}: DocumentPendingMediaBlockProps): React.JSX.Element {
  const store = React.useContext(PendingUploadsContext);
  const status = usePendingStatus(props.uploadId);
  const onRetry = React.useCallback((): void => {
    store.retry(props.uploadId);
  }, [store, props.uploadId]);
  return (
    <DocumentPendingMedia
      name={props.name}
      caption={props.caption}
      status={status}
      onRetry={onRetry}
      onRemove={actions.remove}
    />
  );
});
