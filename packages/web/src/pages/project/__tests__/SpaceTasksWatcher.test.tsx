// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Space tab reads its background-work lists again when collab writes a new change version into the Space's document
 * (root AGENTS.md, Space task state lives in the Space document), and stops once the tab is closed.
 */

import * as React from 'react';
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { SPACE_TASKS_KEY, SPACE_TASKS_VERSION, webAnimationSpaceDocName } from '@breatic/shared';

import { getDoc } from '@web/data/yjs/manager';
import { SpaceTasksWatcher } from '@web/pages/project/SpaceTasksWatcher';

const PROJECT = '60000000-0000-4000-8000-000000000002';

/**
 * Render the watcher for a fresh Space.
 * @returns The client, the document name and the render.
 */
function mount(): { client: QueryClient; name: string; spaceId: string; view: ReturnType<typeof render> } {
  const spaceId = crypto.randomUUID();
  const name = webAnimationSpaceDocName(PROJECT, spaceId);
  const client = new QueryClient();
  const view = render(<QueryClientProvider client={client}><SpaceTasksWatcher projectId={PROJECT} spaceId={spaceId} name={name} /></QueryClientProvider>);
  return { client, name, spaceId, view };
}

describe('SpaceTasksWatcher', () => {
  it('reads the Space\'s lists again when its document\'s executions version moves', () => {
    const { client, name, spaceId } = mount();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { getDoc(name).getMap(SPACE_TASKS_KEY).set(SPACE_TASKS_VERSION, '1-0'); });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['space-tasks', PROJECT, spaceId] });
  });

  it('ignores the document once the tab is closed', () => {
    const { client, name, view } = mount();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    view.unmount();
    act(() => { getDoc(name).getMap(SPACE_TASKS_KEY).set(SPACE_TASKS_VERSION, '2-0'); });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
