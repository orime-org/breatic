// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * An open tab holds its Space's connection; the body reads it from context
 * (inner#1235 §5.1). Hiding the body cleans up the body's effects and must not
 * touch the connection, so a document body keeps its editor instead of
 * falling back to the loading placeholder.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';

const connection = {
  provider: { on: (): void => {}, off: (): void => {} },
  synced: true,
  hasEverSynced: true,
  status: 'connected',
  writeAccess: 'granted',
  authFailedReason: null,
};
const useSocketMock = vi.fn((_options: { name: string }) => connection);
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (options: { name: string }) => useSocketMock(options),
}));

vi.mock('@web/pages/project/SpaceOutlet', async () => {
  const { useSpaceConnection } = await import(
    '@web/data/yjs/space-connection'
  );
  return {
    /**
     * Shows whether the connection it reads is the tab's.
     * @returns The probe.
     */
    SpaceOutlet: (): React.JSX.Element => {
      const read = useSpaceConnection();
      return (
        <span data-testid='body'>
          {read?.hasEverSynced === true ? 'synced' : 'none'}
        </span>
      );
    },
  };
});

vi.mock('@web/spaces/document/document-intercept-guard', () => ({
  DocumentInterceptGuard: (): null => null,
}));

import { docName } from '@web/data/yjs/manager';
import { OpenSpace } from '@web/pages/project/OpenSpace';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';

describe('OpenSpace — the tab holds the connection, the body reads it', () => {
  it('gives the body the tab connection, and keeps it while the body is hidden', () => {
    const { rerender } = render(
      <OpenSpace
        projectId={PID}
        spaceId={SID}
        type='document'
        active
        visited
        readOnly={false}
      />,
    );
    expect(screen.getByTestId('body').textContent).toBe('synced');

    rerender(
      <OpenSpace
        projectId={PID}
        spaceId={SID}
        type='document'
        active={false}
        visited
        readOnly={false}
      />,
    );

    expect(screen.getByTestId('body')).not.toBeVisible();
    expect(screen.getByTestId('body').textContent).toBe('synced');
    expect(useSocketMock).toHaveBeenCalled();
  });

  it('connects to the document of this Space, of this kind, in this project', () => {
    // Everything under the tab reads this connection, the read-only notice
    // included; a canvas and a document Space sharing an id are two documents
    // with two separate seat ceilings.
    useSocketMock.mockClear();
    render(
      <OpenSpace
        projectId={PID}
        spaceId={SID}
        type='canvas'
        active
        visited
        readOnly={false}
      />,
    );
    expect(useSocketMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: docName.canvasSpace(PID, SID) }),
    );
  });

  it('holds the connection but renders no body for a tab never visited', () => {
    render(
      <OpenSpace
        projectId={PID}
        spaceId={SID}
        type='document'
        active={false}
        visited={false}
        readOnly={false}
      />,
    );
    expect(screen.queryByTestId('body')).toBeNull();
    expect(useSocketMock).toHaveBeenCalled();
  });
});
