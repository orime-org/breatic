// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A pending block reads what collab wrote onto it as the editor holds it
 * (#1574): every declared prop is present, an unset one as its empty default.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import type { MediaBlockActions, MediaBlockProps } from '@web/spaces/document/DocumentMediaBlock';
import {
  DocumentPendingMediaBlock,
  PendingUploadsContext,
  type PendingUploadsStore,
} from '@web/spaces/document/document-pending-uploads';

afterEach(() => {
  cleanup();
});

const HOME = 'project-p/document-s';

const STORE: PendingUploadsStore = {
  docName: HOME,
  factsOf: () => ({ entry: undefined, access: 'granted', refused: false, claim: null }),
  subscribe: () => () => {},
  retry: () => {},
};

const ACTIONS = { remove: () => {} } as unknown as MediaBlockActions;

/**
 * Renders one pending block holding these props.
 * @param props - What the editor holds beyond the defaults.
 */
function draw(props: Partial<MediaBlockProps>): void {
  const all = { url: '', name: 'cover.png', caption: '', uploadId: 'u1', uploadHome: HOME, uploadState: '', uploadFailure: '', ...props };
  render(
    <PendingUploadsContext.Provider value={STORE}>
      <DocumentPendingMediaBlock props={all as MediaBlockProps} actions={ACTIONS} />
    </PendingUploadsContext.Provider>,
  );
}

describe('a pending block read from the editor', () => {
  it('names a failure that came with no reason as the plain failure, never as an empty reason', () => {
    draw({ uploadState: 'failed', uploadFailure: '' });

    expect(screen.getByTestId('doc-pending-failure').textContent).toBe('cover.png · Upload failed');
  });

  it('names the reason collab wrote', () => {
    draw({ uploadState: 'failed', uploadFailure: 'unreachable', uploadRetryable: true });

    expect(screen.getByTestId('doc-pending-failure').textContent).toBe('cover.png · The address won’t open');
  });
});
