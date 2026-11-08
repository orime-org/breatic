// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { SceneViewportRuntime } from '@web/spaces/three-d/viewport/scene-viewport-runtime';
import type { SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';

/**
 * The lazy Three boundary; Activity owns its visible resource lifetime.
 * @param props - Plain scene snapshots and session callbacks.
 * @returns The measured viewport host.
 * @throws {never} Renderer construction failures go to the editor's error UI.
 */
const SceneViewport = React.memo(function SceneViewport(props: SceneViewportProps): React.JSX.Element {
  const host = React.useRef<HTMLDivElement>(null);
  const runtime = React.useRef<SceneViewportRuntime | null>(null);
  const latest = React.useRef(props);
  latest.current = props;

  React.useEffect(() => {
    if (!host.current) return;
    let created: SceneViewportRuntime;
    try {
      created = new SceneViewportRuntime(host.current, latest.current);
    } catch (error: unknown) {
      latest.current.onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    runtime.current = created;
    latest.current.onResources?.(created.acquireModel);
    return () => {
      latest.current.onResources?.(null);
      created.dispose();
      runtime.current = null;
    };
  }, []);

  React.useLayoutEffect(() => {
    runtime.current?.update(props);
  }, [props]);

  return <div ref={host} className='relative h-full min-h-0 w-full min-w-0' data-testid='three-d-viewport-host' />;
});

export default SceneViewport;
