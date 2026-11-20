// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
import {
  pendingStatus,
  type PendingBlockFacts,
  type PendingFacts,
  type PendingStatus,
} from '@web/spaces/document/document-pending-status';

/** What a body's pending blocks read from. */
export interface PendingUploadsStore {
  /** The body's document name, which a block's `uploadHome` is checked against; null when it is not known. */
  readonly docName: string | null;
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
  docName: null,
  factsOf: () => ({ entry: undefined, access: 'unknown', refused: false, claim: null }),
  subscribe: () => () => {},
  retry: () => {},
};

/** The store a body's pending blocks read from. */
export const PendingUploadsContext = React.createContext<PendingUploadsStore>(NOTHING_KNOWN);

/**
 * What collab wrote onto a block, as the display reads it.
 * @param props - The block's props.
 * @param docName - The body's document name.
 * @returns The facts.
 */
function blockFactsOf(props: MediaBlockProps, docName: string | null): PendingBlockFacts {
  const state = props.uploadState === 'processing' || props.uploadState === 'failed' ? props.uploadState : '';
  return {
    state,
    ...(props.uploadDeadline !== undefined && { deadline: props.uploadDeadline }),
    ...(props.uploadFailure !== undefined && props.uploadFailure !== '' && { failure: props.uploadFailure as PendingBlockFacts['failure'] }),
    ...(props.uploadRetryable !== undefined && { retryable: props.uploadRetryable }),
    foreign: props.uploadHome !== undefined && docName !== null && props.uploadHome !== docName,
  };
}

/**
 * Now, moved on once when a deadline passes, so a block that runs out reads as timed out without any other change.
 * @param deadline - The block's deadline, when it has one.
 * @returns Now, in epoch ms.
 */
function useNowPast(deadline: number | undefined): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (deadline === undefined || now > deadline) return undefined;
    const timer = setTimeout(() => {
      setNow(Date.now());
    }, deadline - now + 1);
    return () => {
      clearTimeout(timer);
    };
  }, [deadline, now]);
  return now;
}

/**
 * What a pending block shows, kept current.
 * @param props - The block's props.
 * @returns Its status.
 */
function usePendingStatus(props: MediaBlockProps): PendingStatus {
  const store = React.useContext(PendingUploadsContext);
  const now = useNowPast(props.uploadDeadline);
  const block = blockFactsOf(props, store.docName);
  const blockKey = JSON.stringify(block);
  const snapshot = React.useCallback(
    (): string =>
      JSON.stringify(pendingStatus({ ...store.factsOf(props.uploadId), block: JSON.parse(blockKey) as PendingBlockFacts, now })),
    [store, props.uploadId, blockKey, now],
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
  const status = usePendingStatus(props);
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
