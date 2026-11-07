// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

/**
 * Whether the component is still on screen, for answers that arrive after it
 * may have gone (a run-once press outlives the panel that started it).
 * @returns A ref that reads true while mounted.
 */
export function useMountedRef(): React.RefObject<boolean> {
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
