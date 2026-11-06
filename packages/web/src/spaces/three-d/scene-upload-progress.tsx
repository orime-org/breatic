// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSceneControls } from '@web/data/api/scene';
import { useCollabSocketContext } from '@web/data/yjs/collab-socket';
import { getDoc } from '@web/data/yjs/manager';
import { getSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import { pageSceneUploads, type SceneUploads } from '@web/spaces/three-d/scene-uploads';

/**
 * Share this page's progress for the uploads it is sending into one 3D Space,
 * no more often than the configured gap and always ending on the latest value.
 * @param uploads - The page's uploads.
 * @param session - The Space's document session, which owns its awareness.
 * @param spaceId - The Space.
 * @param gapMs - Shortest gap between two shares.
 * @returns A stop that withdraws this page's progress.
 */
export function publishUploadProgress(
  uploads: SceneUploads,
  session: Pick<SceneSession, 'setUploadProgress'>,
  spaceId: string,
  gapMs: number,
): () => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Write the current progress of this Space's sending uploads. */
  const publish = (): void => {
    const progress: Record<string, number> = {};
    for (const entry of uploads.list(spaceId)) if (entry.phase === 'uploading') progress[entry.taskId] = entry.percent;
    session.setUploadProgress(progress);
  };
  /** Publish once the gap since the last share has passed. */
  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; last = Date.now(); publish(); }, Math.max(0, last + gapMs - Date.now()));
  };
  schedule();
  const unsubscribe = uploads.subscribe(schedule);
  return (): void => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    session.setUploadProgress({});
  };
}

/**
 * Keep a 3D Space's upload progress on its peers' screens for as long as its
 * tab is open, including while another tab is on screen; mounted with the tab.
 * @param root0 - The Space.
 * @param root0.projectId - The project.
 * @param root0.spaceId - The 3D Space.
 * @param root0.name - The Space's document name.
 * @returns Nothing visible.
 */
export function SceneUploadProgressPublisher({ projectId, spaceId, name }: { projectId: string; spaceId: string; name: string }): null {
  const { userId } = useCollabSocketContext();
  const controls = useQuery({ queryKey: ['scene-controls', projectId, userId], queryFn: ({ signal }) => getSceneControls(projectId, signal), enabled: Boolean(userId) });
  const gapMs = controls.data?.progressPublishMs;
  React.useEffect(() => {
    if (!userId || gapMs === undefined) return;
    return publishUploadProgress(pageSceneUploads(), getSceneSession(getDoc(name), name), spaceId, gapMs);
  }, [userId, gapMs, name, spaceId]);
  return null;
}
