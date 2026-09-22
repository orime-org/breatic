// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/// <reference types="vite/client" />

// Web Worker module typings
declare module '*.worker?worker' {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}

declare module '*.worker.ts' {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}

interface ImportMetaEnv {
  /** API base including its version prefix; empty means same-origin /api/v1. */
  readonly VITE_API_BASE_URL?: string;
  /** WebSocket URL; empty means same-origin /ws. */
  readonly VITE_COLLAB_URL?: string;
}
